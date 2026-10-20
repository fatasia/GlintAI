/** Shared section heading style for content scenes. */
export const Heading: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => (
  <h2
    style={{
      margin: 0,
      fontSize: "var(--glint-font-size-h1)",
      fontFamily: "var(--glint-font-display)",
      fontWeight: 700,
      lineHeight: 1.25,
      textWrap: "balance",
      lineBreak: "strict",
    }}
  >
    {children}
  </h2>
);
