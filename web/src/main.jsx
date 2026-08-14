import React from "react";
import { createRoot } from "react-dom/client";
import { Liquid } from "liquid-gooey";

// Minimal pipeline proof: React + liquid-gooey bundled and rendering the goo
// effect (two items that merge into one liquid mass).
function Proof() {
  const [open, setOpen] = React.useState(true);
  return (
    <div style={{ display: "grid", placeItems: "center", height: "100%", gap: 24 }}>
      <h1 style={{ font: "600 20px -apple-system, sans-serif", color: "hsl(11 98% 61%)" }}>
        aapp · React + liquid-gooey ✓
      </h1>
      <Liquid fill="hsl(11 98% 61%)" blur={7} contrast={18}
              style={{ display: "flex", gap: open ? 10 : -8, transition: "gap .4s" }}>
        <Liquid.Item effect="morph" style={{ width: 64, height: 64, borderRadius: 20 }} />
        <Liquid.Item effect="morph" style={{ width: 64, height: 64, borderRadius: 20 }} />
        <Liquid.Item effect="morph" style={{ width: 64, height: 64, borderRadius: 20 }} />
      </Liquid>
      <button onClick={() => setOpen((v) => !v)}
              style={{ padding: "10px 16px", borderRadius: 12, border: "1px solid #ccc", background: "#fff" }}>
        toggle merge
      </button>
    </div>
  );
}

createRoot(document.getElementById("root")).render(<Proof />);
