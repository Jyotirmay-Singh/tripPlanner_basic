// @ts-nocheck
import { ScrollViewStyleReset } from "expo-router/html";
import type { PropsWithChildren } from "react";

export default function Root({ children }: PropsWithChildren) {
  return (
    <html lang="en" style={{ height: "100%" }}>
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, shrink-to-fit=no"
        />
        {/*
          Disable body scrolling on web to make ScrollView components work correctly.
          If you want to enable scrolling, remove `ScrollViewStyleReset` and
          set `overflow: auto` on the body style below.
        */}
        <ScrollViewStyleReset />
        <style
          dangerouslySetInnerHTML={{
            __html: `
              body > div:first-child { position: fixed !important; top: 0; left: 0; right: 0; bottom: 0; }
              [role="tablist"] [role="tab"] * { overflow: visible !important; }
              [role="heading"], [role="heading"] * { overflow: visible !important; }
              /* Inputs carry their own themed focus ring (see src/ui/Input.tsx), so drop the
                 browser's default outline here. No :focus-visible ring — a second, offset outline
                 stacked on the component's ring and rendered as green corner squares + a faint
                 double-edge (worse under fractional display scaling). */
              input, textarea, select { outline: none; }
              /* Browser autofill (Chrome/Safari) repaints the native <input> a light color that
                 clashes with the app theme. react-native-web's <input> is transparent (the themed
                 fill is on the wrapping View — see src/ui/Input.tsx), so autofill's paint sits on
                 top of the theme. Per MDN the autofill background can't be set directly: repaint it
                 with an inset box-shadow and force the text with -webkit-text-fill-color.
                 --autofill-* are set at runtime from the live theme by ThemeContext; the values
                 below are graceful first-paint fallbacks (see src/theme.ts). */
              :root { color-scheme: light; --autofill-bg: #EDEBE3; --autofill-text: #121A18; }
              @media (prefers-color-scheme: dark) {
                :root { color-scheme: dark; --autofill-bg: #1A221F; --autofill-text: #F7F5F0; }
              }
              input:-webkit-autofill,
              input:-webkit-autofill:hover,
              input:-webkit-autofill:focus,
              input:-webkit-autofill:active {
                -webkit-box-shadow: 0 0 0 1000px var(--autofill-bg) inset !important;
                box-shadow: 0 0 0 1000px var(--autofill-bg) inset !important;
                -webkit-text-fill-color: var(--autofill-text) !important;
                caret-color: var(--autofill-text);
                /* Delay the browser's default background transition ~forever so it never flashes light. */
                transition: background-color 100000s ease-in-out 0s, color 100000s ease-in-out 0s;
              }
              input:autofill,
              input:autofill:hover,
              input:autofill:focus,
              input:autofill:active {
                box-shadow: 0 0 0 1000px var(--autofill-bg) inset !important;
                -webkit-text-fill-color: var(--autofill-text) !important;
                caret-color: var(--autofill-text);
                transition: background-color 100000s ease-in-out 0s, color 100000s ease-in-out 0s;
              }
            `,
          }}
        />
      </head>
      <body
        style={{
          margin: 0,
          height: "100%",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {children}
      </body>
    </html>
  );
}
