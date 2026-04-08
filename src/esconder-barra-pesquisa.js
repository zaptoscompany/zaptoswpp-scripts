(function hideGhlGlobalSearchBar() {
  "use strict";

  if (window.__zaptosHideGlobalSearchBarLoaded) return;
  window.__zaptosHideGlobalSearchBarLoaded = true;

  const STYLE_ID = "zaptos-hide-global-search-style";
  const TARGET_SELECTOR = "#globalSearchOpener";

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      ${TARGET_SELECTOR} {
        display: none !important;
        visibility: hidden !important;
        height: 0 !important;
        min-height: 0 !important;
        margin: 0 !important;
        padding: 0 !important;
        overflow: hidden !important;
        pointer-events: none !important;
      }
    `;

    (document.head || document.documentElement).appendChild(style);
  }

  function hideElementInline() {
    const searchBar = document.querySelector(TARGET_SELECTOR);
    if (!searchBar) return;

    searchBar.style.setProperty("display", "none", "important");
    searchBar.style.setProperty("visibility", "hidden", "important");
    searchBar.style.setProperty("height", "0", "important");
    searchBar.style.setProperty("margin", "0", "important");
    searchBar.style.setProperty("padding", "0", "important");
    searchBar.style.setProperty("overflow", "hidden", "important");
    searchBar.style.setProperty("pointer-events", "none", "important");
    searchBar.setAttribute("aria-hidden", "true");
  }

  function boot() {
    injectStyle();
    hideElementInline();

    if (window.__zaptosHideGlobalSearchObserver) {
      window.__zaptosHideGlobalSearchObserver.disconnect();
    }

    const observer = new MutationObserver(() => {
      hideElementInline();
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });

    window.__zaptosHideGlobalSearchObserver = observer;
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
