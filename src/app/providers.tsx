"use client";

import { MantineProvider, createTheme, type MantineColorsTuple } from "@mantine/core";

const learnRecurBlue: MantineColorsTuple = [
  "hsl(219 100% 97%)",
  "hsl(219 100% 93%)",
  "hsl(220 100% 86%)",
  "hsl(219 93% 77%)",
  "hsl(218 84% 67%)",
  "hsl(217 79% 58%)",
  "hsl(218 77% 49%)",
  "hsl(219 97% 42%)",
  "hsl(219 97% 35%)",
  "hsl(220 96% 27%)",
];

const theme = createTheme({
  colors: {
    learnRecurBlue,
  },
  primaryColor: "learnRecurBlue",
  primaryShade: 7,
  fontFamily: "var(--font-lexend), sans-serif",
  headings: {
    fontFamily: "var(--font-lexend), sans-serif",
    fontWeight: "500",
  },
  defaultRadius: "5px",
});

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <MantineProvider defaultColorScheme="light" theme={theme}>
      {children}
    </MantineProvider>
  );
}
