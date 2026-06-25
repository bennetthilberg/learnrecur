"use client";

import { MantineProvider, createTheme, rem } from "@mantine/core";
import { Notifications } from "@mantine/notifications";

const theme = createTheme({
  fontFamily: "'Instrument Sans', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  fontFamilyMonospace: "ui-monospace, SFMono-Regular, Menlo, monospace",
  headings: {
    fontFamily: "'Plus Jakarta Sans', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
    fontWeight: "700",
  },
  primaryColor: "brand",
  primaryShade: 6,
  defaultRadius: rem(8),
  white: "#FFFFFF",
  black: "#15233F",
  colors: {
    brand: [
      "#EEF3FC",
      "#D7E2F6",
      "#AEC2EC",
      "#8099DE",
      "#4F6ECB",
      "#2C53BB",
      "#1C44A8",
      "#193E9C",
      "#143479",
      "#0F2A63",
    ],
    leaf: [
      "#E7F5EE",
      "#CBEAD9",
      "#9AD6B8",
      "#63BE92",
      "#2E9E6E",
      "#13885A",
      "#0C7D52",
      "#0A6C47",
      "#08573A",
      "#063F2A",
    ],
    amber: [
      "#FBEDE6",
      "#F6D2C2",
      "#EDA888",
      "#E27C52",
      "#D2592A",
      "#C44C18",
      "#B8440F",
      "#9C3A0D",
      "#7E2F0B",
      "#5C2208",
    ],
    slate: [
      "#F6F7F9",
      "#EDEFF3",
      "#E4E8F1",
      "#D7DAE2",
      "#C9CFDC",
      "#8A92A6",
      "#5A6480",
      "#44557A",
      "#2B3754",
      "#15233F",
    ],
  },
  components: {
    Card: {
      defaultProps: { radius: rem(8), withBorder: true },
      styles: { root: { borderColor: "#E4E8F1" } },
    },
    Paper: { defaultProps: { radius: rem(8) } },
    Badge: { defaultProps: { radius: rem(6) } },
    Notification: {
      defaultProps: { radius: rem(8), withBorder: true },
      styles: {
        root: {
          borderColor: "#E4E8F1",
          boxShadow: "none",
        },
        title: {
          color: "#15233F",
          fontFamily: "'Instrument Sans', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
          fontSize: rem(14),
          fontWeight: 700,
        },
        description: {
          color: "#5A6480",
          fontSize: rem(13.5),
          lineHeight: 1.45,
        },
      },
    },
  },
});

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <MantineProvider defaultColorScheme="light" theme={theme}>
      <Notifications autoClose={5000} limit={3} position="top-right" zIndex={3000} />
      {children}
    </MantineProvider>
  );
}
