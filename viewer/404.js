window.addEventListener("DOMContentLoaded", () => {
  const nav = document.getElementById("nav");
  if (nav && window.MelbBeerBusiness) {
    nav.innerHTML = window.MelbBeerBusiness.renderNav("");
  }
});
