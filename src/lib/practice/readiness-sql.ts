import "server-only";

import {
  AnswerKind,
  ExerciseVerificationStatus,
  Prisma,
} from "@/generated/prisma/client";
import {
  MAX_MATH_ACCEPTED_EXPRESSIONS,
  MAX_MATH_EXPRESSION_LENGTH,
} from "@/lib/answer-checking";
import {
  MAX_NUMERIC_ANSWER_LENGTH,
  MAX_TEXT_ANSWER_LENGTH,
} from "@/lib/answer-limits";
import { NATURAL_TEXT_POLICY } from "@/lib/practice/policies";

type Sql = Prisma.Sql;

export type ReadyExerciseSqlInput = {
  repetitions: Sql;
  alreadyStudied: Sql;
  textPolicy: Sql;
};

/**
 * The read model falls back to the natural policy when neither the skill nor
 * its collection overrides it. Keep this expression parameterized so callers
 * can safely compose it into a larger Prisma query.
 */
export const DEFAULT_READY_TEXT_POLICY_SQL = Prisma.sql`
  ${JSON.stringify(NATURAL_TEXT_POLICY)}::jsonb
`;

function objectKeyCount(value: Sql): Sql {
  return Prisma.sql`
    CASE
      WHEN jsonb_typeof(${value}) = 'object' THEN (
        SELECT COUNT(*) FROM jsonb_object_keys(${value})
      )
      ELSE -1
    END
  `;
}

function arrayOrEmpty(value: Sql): Sql {
  return Prisma.sql`
    CASE
      WHEN jsonb_typeof(${value}) = 'array' THEN ${value}
      ELSE '[]'::jsonb
    END
  `;
}

function safeNumericText(value: Sql): Sql {
  return Prisma.sql`
    CASE
      WHEN jsonb_typeof(${value}) = 'number' THEN (${value} #>> '{}')::numeric::text
      ELSE NULL
    END
  `;
}

function safeIntegerNumber(value: Sql): Sql {
  return Prisma.sql`
    CASE
      WHEN jsonb_typeof(${value}) = 'number' THEN (${value} #>> '{}')::numeric % 1 = 0
      ELSE FALSE
    END
  `;
}

function choiceReadySql(): Sql {
  const answerSpec = Prisma.sql`e."answerSpec"`;
  const choices = Prisma.sql`e."choices"`;
  const safeChoices = arrayOrEmpty(choices);
  const choice = Prisma.sql`choice`;

  return Prisma.sql`(
    e."answerKind" = ${AnswerKind.CHOICE}::"AnswerKind"
    AND jsonb_typeof(${choices}) = 'array'
    AND jsonb_array_length(${safeChoices}) > 0
    AND ${objectKeyCount(answerSpec)} = 2
    AND ${answerSpec}->>'kind' = 'choice'
    AND jsonb_typeof(${answerSpec}->'correctChoiceId') = 'string'
    AND COALESCE(btrim(${answerSpec}->>'correctChoiceId'), '') <> ''
    AND EXISTS (
      SELECT 1
      FROM jsonb_array_elements(${safeChoices}) ${choice}
      WHERE btrim(${choice}->>'id') = btrim(${answerSpec}->>'correctChoiceId')
    )
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(${safeChoices}) ${choice}
      WHERE jsonb_typeof(${choice}) <> 'object'
         OR jsonb_typeof(${choice}->'id') <> 'string'
         OR COALESCE(btrim(${choice}->>'id'), '') = ''
         OR jsonb_typeof(${choice}->'label') <> 'string'
         OR COALESCE(btrim(${choice}->>'label'), '') = ''
         OR ${objectKeyCount(choice)} <> 2
    )
    AND (
      SELECT COUNT(DISTINCT btrim(${choice}->>'id'))
      FROM jsonb_array_elements(${safeChoices}) ${choice}
    ) = jsonb_array_length(${safeChoices})
  )`;
}

function textReadySql(textPolicy: Sql): Sql {
  const answerSpec = Prisma.sql`e."answerSpec"`;
  const accepted = Prisma.sql`${answerSpec}->'accepted'`;
  const effectivePolicy = Prisma.sql`(${textPolicy})`;

  return Prisma.sql`(
    e."answerKind" = ${AnswerKind.TEXT}::"AnswerKind"
    AND ${answerSpec}->>'kind' = 'text'
    AND ${objectKeyCount(answerSpec)} = 6
    AND jsonb_typeof(${answerSpec}->'policyVersion') = 'number'
    AND jsonb_typeof(${answerSpec}->'accepted') = 'array'
    AND jsonb_typeof(${answerSpec}->'normalizeCase') = 'boolean'
    AND jsonb_typeof(${answerSpec}->'normalizeWhitespace') = 'boolean'
    AND jsonb_typeof(${answerSpec}->'normalizeDiacritics') = 'boolean'
    AND jsonb_array_length(${arrayOrEmpty(accepted)}) > 0
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(${arrayOrEmpty(accepted)}) accepted
      WHERE jsonb_typeof(accepted) <> 'string'
         OR COALESCE(btrim(accepted #>> '{}'), '') = ''
         OR length(accepted #>> '{}') > ${MAX_TEXT_ANSWER_LENGTH}
    )
    AND ${answerSpec}->>'policyVersion' = ${effectivePolicy}->>'version'
    AND ${answerSpec}->>'normalizeCase' = ${effectivePolicy}->>'normalizeCase'
    AND ${answerSpec}->>'normalizeWhitespace' = ${effectivePolicy}->>'normalizeWhitespace'
    AND ${answerSpec}->>'normalizeDiacritics' = 'false'
    AND jsonb_typeof(${effectivePolicy}->'version') = 'number'
    AND ${effectivePolicy}->>'version' = '2'
    AND jsonb_typeof(${effectivePolicy}->'profile') = 'string'
    AND ${effectivePolicy}->>'profile' IN ('CUSTOM', 'NATURAL', 'EXACT')
    AND ${objectKeyCount(effectivePolicy)} = 4
    AND jsonb_typeof(${effectivePolicy}->'normalizeCase') = 'boolean'
    AND jsonb_typeof(${effectivePolicy}->'normalizeWhitespace') = 'boolean'
    AND (
      ${effectivePolicy}->>'profile' = 'CUSTOM'
      OR (
        ${effectivePolicy}->>'profile' = 'NATURAL'
        AND ${effectivePolicy}->>'normalizeCase' = 'true'
        AND ${effectivePolicy}->>'normalizeWhitespace' = 'true'
      )
      OR (
        ${effectivePolicy}->>'profile' = 'EXACT'
        AND ${effectivePolicy}->>'normalizeCase' = 'false'
        AND ${effectivePolicy}->>'normalizeWhitespace' = 'false'
      )
    )
  )`;
}

function numericReadySql(): Sql {
  const answerSpec = Prisma.sql`e."answerSpec"`;
  const accepted = Prisma.sql`${answerSpec}->'accepted'`;

  return Prisma.sql`(
    e."answerKind" = ${AnswerKind.NUMERIC}::"AnswerKind"
    AND ${answerSpec}->>'kind' = 'numeric'
    AND ${objectKeyCount(answerSpec)} = CASE WHEN ${answerSpec} ? 'tolerance' THEN 3 ELSE 2 END
    AND CASE
      WHEN ${answerSpec} ? 'tolerance' THEN
        CASE
          WHEN jsonb_typeof(${answerSpec}->'tolerance') = 'number' THEN
            (${answerSpec}->>'tolerance')::numeric >= 0
          ELSE FALSE
        END
      ELSE TRUE
    END
    AND jsonb_typeof(${answerSpec}->'accepted') = 'array'
    AND jsonb_array_length(${arrayOrEmpty(accepted)}) > 0
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(${arrayOrEmpty(accepted)}) accepted
      WHERE (
        (
          jsonb_typeof(accepted) = 'number'
          AND length(${safeNumericText(Prisma.sql`accepted`)}) <= ${MAX_NUMERIC_ANSWER_LENGTH}
        )
        OR (
          jsonb_typeof(accepted) = 'string'
          AND length(btrim(accepted #>> '{}')) BETWEEN 1 AND ${MAX_NUMERIC_ANSWER_LENGTH}
        )
        OR (
          jsonb_typeof(accepted) = 'object'
          AND jsonb_typeof(accepted->'type') = 'string'
          AND accepted->>'type' IN ('integer', 'decimal')
          AND ${objectKeyCount(Prisma.sql`accepted`)} = 2
          AND jsonb_typeof(accepted->'value') = 'number'
          AND length(${safeNumericText(Prisma.sql`accepted->'value'`)}) <= ${MAX_NUMERIC_ANSWER_LENGTH}
          AND CASE
            WHEN accepted->>'type' = 'integer' THEN
              ${safeIntegerNumber(Prisma.sql`accepted->'value'`)}
            ELSE TRUE
          END
        )
        OR (
          jsonb_typeof(accepted) = 'object'
          AND jsonb_typeof(accepted->'type') = 'string'
          AND accepted->>'type' = 'fraction'
          AND (
            (
              ${objectKeyCount(Prisma.sql`accepted`)} = 3
              AND jsonb_typeof(accepted->'numerator') = 'number'
              AND jsonb_typeof(accepted->'denominator') = 'number'
              AND ${safeIntegerNumber(Prisma.sql`accepted->'numerator'`)}
              AND ${safeIntegerNumber(Prisma.sql`accepted->'denominator'`)}
              AND length(${safeNumericText(Prisma.sql`accepted->'numerator'`)})
                + 1
                + length(${safeNumericText(Prisma.sql`accepted->'denominator'`)})
                <= ${MAX_NUMERIC_ANSWER_LENGTH}
            )
            OR (
              ${objectKeyCount(Prisma.sql`accepted`)} = 2
              AND jsonb_typeof(accepted->'value') = 'string'
              AND length(btrim(accepted->>'value')) BETWEEN 1 AND ${MAX_NUMERIC_ANSWER_LENGTH}
            )
          )
        )
      ) IS NOT TRUE
    )
  )`;
}

function mathReadySql(): Sql {
  const answerSpec = Prisma.sql`e."answerSpec"`;
  const acceptedExpressions = Prisma.sql`${answerSpec}->'acceptedExpressions'`;

  return Prisma.sql`(
    e."answerKind" = ${AnswerKind.MATH}::"AnswerKind"
    AND ${answerSpec}->>'kind' = 'math'
    AND ${objectKeyCount(answerSpec)} = CASE WHEN ${answerSpec} ? 'equivalence' THEN 3 ELSE 2 END
    AND CASE
      WHEN ${answerSpec} ? 'equivalence' THEN
        jsonb_typeof(${answerSpec}->'equivalence') = 'string'
        AND ${answerSpec}->>'equivalence' = 'basic-symbolic'
      ELSE TRUE
    END
    AND jsonb_typeof(${answerSpec}->'acceptedExpressions') = 'array'
    AND jsonb_array_length(${arrayOrEmpty(acceptedExpressions)})
      BETWEEN 1 AND ${MAX_MATH_ACCEPTED_EXPRESSIONS}
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(${arrayOrEmpty(acceptedExpressions)}) expression
      WHERE jsonb_typeof(expression) <> 'string'
         OR COALESCE(btrim(expression #>> '{}'), '') = ''
         OR length(btrim(expression #>> '{}')) > ${MAX_MATH_EXPRESSION_LENGTH}
    )
  )`;
}

/**
 * Build the single source of truth for SQL readiness checks. Every consumer
 * must alias its exercise table as `e`; the skill expressions are supplied by
 * the surrounding query because progress, attention, and library reads join
 * the skill and effective text policy differently.
 *
 * The SQL mirrors the strict answer-spec shape and bounded inventory checks.
 * Math expression parsing remains the Compute Engine's TypeScript concern;
 * SQL rejects malformed JSON shape and budget violations before that layer.
 */
export function buildReadyExerciseSql(input: ReadyExerciseSqlInput): Sql {
  const choiceReady = choiceReadySql();
  const textReady = textReadySql(input.textPolicy);
  const numericReady = numericReadySql();
  const mathReady = mathReadySql();

  return Prisma.sql`
    e."verificationStatus" = ${ExerciseVerificationStatus.VERIFIED}::"ExerciseVerificationStatus"
    AND e."retiredAt" IS NULL
    AND (
      ${choiceReady}
      OR (
        (${input.alreadyStudied} = TRUE OR ${input.repetitions} >= 3)
        AND (
          ${textReady}
          OR ${numericReady}
          OR ${mathReady}
        )
      )
    )
  `;
}
