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
    alternativeMethods: {
      marginTop: "18px",
      overflow: "visible",
    },
    alternativeMethodsBlockButton: {
      marginBottom: "18px",
      marginTop: "14px",
      minHeight: "38px",
      overflow: "visible",
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
      display: "flex",
      flexWrap: "wrap",
      gap: "4px",
      justifyContent: "center",
      marginTop: "18px",
      paddingTop: "18px",
      textAlign: "center",
    },
    footerActionLink: {
      color: "#1C44A8",
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
      minHeight: "44px",
      overflow: "visible",
      paddingBottom: "5px",
      paddingTop: "2px",
      boxShadow: "0 3px 0 #CDD4E1",
    },
  },
} as const;

// Applied globally at <ClerkProvider> so non-auth Clerk surfaces (the header
// UserButton popover, account management) inherit the app's color/font/radius
// tokens instead of Clerk defaults. The full element styling above is kept on
// the SignIn/SignUp cards.
export const clerkBaseAppearance = {
  variables: clerkAppearance.variables,
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
