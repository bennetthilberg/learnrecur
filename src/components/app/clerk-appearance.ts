export const clerkAppearance = {
  variables: {
    borderRadius: "8px",
    colorBackground: "#FFFFFF",
    colorInputBackground: "#FFFFFF",
    colorInputBorder: "#DCE2EC",
    colorInputText: "#15233F",
    colorPrimary: "#1C44A8",
    colorText: "#15233F",
    colorTextSecondary: "#5A6480",
    fontFamily: "var(--lr-font-body)",
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
      color: "#1C44A8",
      fontWeight: "600",
    },
    formButtonPrimary: {
      minHeight: "38px",
      borderRadius: "8px",
      boxShadow: "0 3px 0 #143479",
      fontSize: "13.5px",
      fontWeight: "600",
    },
    formFieldInput: {
      minHeight: "42px",
      border: "1px solid #DCE2EC",
      boxShadow: "none",
      fontSize: "14px",
    },
    formFieldLabel: {
      color: "#2B3754",
      fontSize: "13px",
      fontWeight: "500",
    },
    headerSubtitle: {
      color: "#5A6480",
      fontSize: "13px",
      lineHeight: "1.45",
    },
    headerTitle: {
      color: "#15233F",
      fontSize: "20px",
      fontWeight: "700",
      lineHeight: "1.25",
    },
    rootBox: {
      width: "100%",
    },
    socialButtonsIconButton: {
      minHeight: "38px",
      boxShadow: "0 3px 0 #CDD4E1",
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
