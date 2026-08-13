// Live app icon / favicon / manifest — ported from app.html. The agent can push
// an emoji or an image url via `icon` events; we render a rounded-square glyph
// icon to a canvas and wire it into apple-touch-icon, favicon, manifest and the
// header avatar.

export function renderGlyphIcon(glyph) {
  var c = document.createElement("canvas");
  c.width = c.height = 180;
  var x = c.getContext("2d");
  var g = x.createLinearGradient(0, 0, 0, 180);
  g.addColorStop(0, "#3f3f46");
  g.addColorStop(1, "#18181b");
  var r = 40;
  x.fillStyle = g;
  x.beginPath();
  x.moveTo(r, 0);
  x.arcTo(180, 0, 180, 180, r);
  x.arcTo(180, 180, 0, 180, r);
  x.arcTo(0, 180, 0, 0, r);
  x.arcTo(0, 0, 180, 0, r);
  x.closePath();
  x.fill();
  x.fillStyle = "#fff";
  x.textAlign = "center";
  x.textBaseline = "middle";
  x.font = '104px -apple-system,"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';
  x.fillText(glyph || "◈", 90, 100);
  return c.toDataURL("image/png");
}

function iconLink(rel) {
  var l = document.querySelector('link[rel="' + rel + '"]');
  if (!l) {
    l = document.createElement("link");
    l.rel = rel;
    document.head.appendChild(l);
  }
  return l;
}

// applyIcon updates favicon/apple-touch-icon/manifest and the header avatar
// element (passed in, since it lives in React). `name` is the current app name.
export function applyIcon(url, emoji, avatarEl, name) {
  try {
    iconLink("apple-touch-icon").href = url;
  } catch (e) {}
  try {
    iconLink("icon").href = url;
  } catch (e) {}
  if (avatarEl) {
    if (emoji) {
      avatarEl.textContent = emoji;
      avatarEl.style.background = "";
      avatarEl.style.backgroundSize = "";
    } else {
      avatarEl.textContent = "";
      avatarEl.style.background = "center/cover no-repeat url('" + url + "')";
    }
  }
  try {
    var man = {
      name: name || "Agent",
      short_name: name || "Agent",
      start_url: ".",
      scope: ".",
      display: "standalone",
      background_color: "#0a0a0a",
      theme_color: "#0a0a0a",
      icons: [
        { src: url, sizes: "180x180", type: "image/png" },
        { src: url, sizes: "512x512", type: "image/png" },
      ],
    };
    iconLink("manifest").href = URL.createObjectURL(
      new Blob([JSON.stringify(man)], { type: "application/manifest+json" })
    );
  } catch (e) {}
}
