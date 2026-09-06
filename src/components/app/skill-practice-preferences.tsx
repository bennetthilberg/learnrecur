import { getPrisma } from "@/lib/prisma";
import {
  resolvePracticePreference,
  resolveTextPolicy,
  textPolicySchema,
} from "@/lib/practice/policies";
import { PracticePreferencesForm } from "./practice-preferences-form";

export async function SkillPracticePreferences({
  userId,
  skillId,
}: {
  userId: string;
  skillId: string;
}) {
  const skill = await getPrisma().skill.findFirst({
    where: { id: skillId, userId },
    include: {
      user: { select: { practicePreference: true } },
      collection: { select: { practicePreference: true, textPolicy: true } },
    },
  });
  if (!skill) return null;
  return (
    <details className="skillDetailCard skillFormDetails skillPracticePreferences">
      <summary>Advanced practice preferences</summary>
      <div style={{ paddingTop: 16 }}>
        <PracticePreferencesForm
          target={{ scope: "skill", id: skill.id }}
          preference={skill.practicePreference}
          inheritedPreference={resolvePracticePreference({
            collection: skill.collection?.practicePreference,
            user: skill.user.practicePreference,
          })}
          textPolicy={
            skill.textPolicy ? textPolicySchema.parse(skill.textPolicy) : null
          }
          inheritedTextPolicy={resolveTextPolicy({
            collection: skill.collection?.textPolicy,
          })}
          alreadyStudied={skill.alreadyStudied}
        />
      </div>
    </details>
  );
}
