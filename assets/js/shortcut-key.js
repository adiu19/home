// Check if the user is on a Mac and update the shortcut key for search accordingly
document.addEventListener("readystatechange", () => {
  if (document.readyState === "interactive") {
    let isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0;
    let shortcutKeyElement = document.querySelector("#search-toggle .nav-link");
    if (shortcutKeyElement && isMac) {
      // use the unicode for command key
      shortcutKeyElement.innerHTML = '&#x2318; k <i class="fa-solid fa-magnifying-glass"></i>';
    }
  }
});

// Stripe-style single-key navigation shortcuts
document.addEventListener("keydown", (e) => {
  // Don't trigger when typing in inputs, textareas, or contenteditable elements
  const tag = e.target.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select" || e.target.isContentEditable) return;

  // Don't trigger with modifier keys (except shift for uppercase)
  if (e.ctrlKey || e.metaKey || e.altKey) return;

  // Don't trigger if search modal is open
  const ninja = document.querySelector("ninja-keys");
  if (ninja && ninja.visible) return;

  const key = e.key.toUpperCase();
  const link = document.querySelector(`.nav-link[data-shortcut="${key}"]`);
  if (link) {
    e.preventDefault();
    link.click();
  }
});
