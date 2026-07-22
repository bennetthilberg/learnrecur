import { designTokens } from "@/lib/design-tokens";

export const clerkAppearance = {
  variables: {
    borderRadius: designTokens.radius,
    colorBackground: designTokens.colorCard,
    colorInputBackground: designTokens.colorCard,
    colorInputBorder: designTokens.colorChipBorder,
    colorInputText: designTokens.colorInk,
    colorPrimary: designTokens.colorPrimary,
    colorText: designTokens.colorInk,
    colorTextSecondary: designTokens.colorTextSecondary,
    fontFamily: "var(--lr-font-body)",
    fontSize: "14px",
  },
  elements: {
    alternativeMethods: {
      marginTop: "0",
      overflow: "visible",
      paddingBottom: "34px",
    },
    alternativeMethodsBlockButton: {
      alignItems: "center",
      backgroundColor: designTokens.colorCard,
      border: `1px solid ${designTokens.colorButtonWhiteBorder}`,
      borderRadius: designTokens.radius,
      boxShadow: `0 3px 0 ${designTokens.colorButtonWhiteEdge}`,
      color: designTokens.colorInk,
      display: "flex",
      fontSize: "14px",
      fontWeight: "600",
      gap: "8px",
      justifyContent: "center",
      marginBottom: "0",
      marginTop: "0",
      minHeight: "44px",
      overflow: "visible",
      padding: "10px 16px",
      width: "100%",
    },
    card: {
      boxShadow: "none",
      overflow: "visible",
      padding: "0",
      width: "100%",
    },
    cardBox: {
      boxShadow: "none",
      overflow: "visible",
      width: "100%",
    },
    footerAction: {
      alignItems: "center",
      boxSizing: "border-box",
      display: "flex",
      flexWrap: "wrap",
      gap: "4px",
      justifyContent: "center",
      marginTop: "18px",
      paddingTop: "18px",
      textAlign: "center",
      width: "100%",
    },
    footerActionLink: {
      color: designTokens.colorPrimary,
      flex: "0 0 auto",
      fontWeight: "600",
      margin: "0",
      width: "auto",
    },
    footerActionText: {
      flex: "0 0 auto",
      margin: "0",
      width: "auto",
    },
    formButtonPrimary: {
      minHeight: "44px",
      borderRadius: designTokens.radius,
      boxShadow: `0 3px 0 ${designTokens.colorPrimaryEdge}`,
      fontSize: "15px",
      fontWeight: "600",
    },
    formFieldInput: {
      minHeight: "42px",
      border: `1px solid ${designTokens.colorChipBorder}`,
      boxShadow: "none",
      fontSize: "14px",
    },
    formFieldLabel: {
      color: designTokens.colorPreferenceLabel,
      fontSize: "13px",
      fontWeight: "500",
    },
    headerSubtitle: {
      color: designTokens.colorTextSecondary,
      fontSize: "13px",
      lineHeight: "1.45",
    },
    headerTitle: {
      color: designTokens.colorInk,
      fontSize: "20px",
      fontWeight: "700",
      lineHeight: "1.25",
    },
    main: {
      overflow: "visible",
    },
    rootBox: {
      overflow: "visible",
      width: "100%",
    },
    socialButtons: {
      gap: "12px",
      overflow: "visible",
      paddingBottom: "4px",
    },
    socialButtonsBlockButton: {
      minHeight: "44px",
      overflow: "visible",
    },
    socialButtonsIconButton: {
      alignItems: "center",
      minHeight: "46px",
      overflow: "visible",
      paddingBottom: "6px",
      paddingTop: "4px",
      boxShadow: `0 3px 0 ${designTokens.colorButtonWhiteEdge}`,
    },
  },
} as const;

export const clerkLocalization = {
  signIn: {
    start: {
      subtitle: "Sign in with your LearnRecur account.",
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
