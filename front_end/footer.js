(function addRecipeFinderFooter() {
  if (document.getElementById("recipeFinderFooter")) {
    return;
  }

  try {
    localStorage.setItem("preferredLanguage", "English");
  } catch (err) {
    // Ignore storage errors to keep footer rendering.
  }

  const style = document.createElement("style");
  style.textContent = `
    body {
      padding-bottom: 64px;
    }
    .recipe-finder-footer {
      position: fixed;
      left: 0;
      right: 0;
      bottom: 0;
      z-index: 1000;
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      align-items: center;
      justify-content: center;
      padding: 12px 16px;
      background: rgba(0, 0, 0, 0.88);
      border-top: 1px solid rgba(255, 215, 0, 0.3);
      backdrop-filter: blur(8px);
      color: #f2f2f2;
      font-family: 'Poppins', sans-serif;
      font-size: 13px;
      text-align: center;
    }
    .recipe-finder-footer a {
      color: #ffd700;
      text-decoration: none;
    }
  `;
  document.head.appendChild(style);

  const year = new Date().getFullYear();
  const footer = document.createElement("footer");
  footer.id = "recipeFinderFooter";
  footer.className = "recipe-finder-footer";
  footer.innerHTML = `
    <span>Copyright © ${year} Recipe Finder. All rights reserved.</span>
    <span>|</span>
    <a href="/contact">Contact Admin</a>
    <span>|</span>
    <a href="mailto:hamethanasren@gmail.com">hamethanasren@gmail.com</a>
  `;
  document.body.appendChild(footer);
})();
