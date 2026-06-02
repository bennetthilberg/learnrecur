"use client";

import { MantineProvider, createTheme, type MantineColorsTuple } from "@mantine/core";

const learnRecurBlue: MantineColorsTuple = [
  "#eef4ff",
  "#dce8ff",
  "#b8d0ff",
  "#8db4fb",
  "#6598f2",
  "#3e7ee8",
  "#1d65df",
  "#034cd5",
  "#033fae",
  "#032f86",
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
