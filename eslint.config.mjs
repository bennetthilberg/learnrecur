import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";

const eslintConfig = [
  {
    ignores: [
      "coverage/**",
      "playwright-report/**",
      "references/**",
      "src/generated/prisma/**",
      "test-results/**",
    ],
  },
  ...nextVitals,
  ...nextTypeScript,
];

export default eslintConfig;
