export const clerkAppearance = {
  variables: {
    borderRadius: "5px",
    colorBackground: "hsl(0 0% 100%)",
    colorInputBackground: "hsl(0 0% 100%)",
    colorInputBorder: "hsl(213 24% 82%)",
    colorInputText: "hsl(215 31% 11%)",
    colorPrimary: "hsl(219 97% 42%)",
    colorText: "hsl(215 31% 11%)",
    colorTextSecondary: "hsl(211 16% 35%)",
    fontFamily: "var(--font-lexend), Lexend, sans-serif",
    fontSize: "14px",
  },
  elements: {
    card: {
      boxShadow: "none",
      padding: "0",
      width: "100%",
    },
    cardBox: {
      boxShadow: "none",
      width: "100%",
    },
    footerActionLink: {
      color: "hsl(218 98% 31%)",
      fontWeight: "500",
    },
    formButtonPrimary: {
      minHeight: "38px",
      borderRadius: "5px",
      boxShadow: "none",
      fontSize: "14px",
      fontWeight: "500",
    },
    formFieldInput: {
      minHeight: "42px",
      border: "1px solid hsl(213 24% 82%)",
      boxShadow: "none",
      fontSize: "14px",
    },
    formFieldLabel: {
      color: "hsl(211 16% 35%)",
      fontSize: "13px",
      fontWeight: "500",
    },
    headerSubtitle: {
      color: "hsl(211 16% 35%)",
      fontSize: "13px",
      lineHeight: "1.45",
    },
    headerTitle: {
      color: "hsl(215 31% 11%)",
      fontSize: "20px",
      fontWeight: "500",
      lineHeight: "1.25",
    },
    rootBox: {
      width: "100%",
    },
    socialButtonsIconButton: {
      minHeight: "38px",
      boxShadow: "0 0 0 1px hsl(212 27% 89%)",
    },
  },
} as const;

export const clerkLocalization = {
  signIn: {
    start: {
      subtitle: "Use your account to continue.",
      title: "Sign in",
    },
  },
  signUp: {
    start: {
      subtitle: "Create your private study workspace.",
      title: "Create account",
    },
  },
} as const;
