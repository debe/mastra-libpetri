(async () => {
  const s = document.querySelector('#dot-diagram svg');
  const tick = () => new Promise((r) => setTimeout(r, 120));
  for (let i = 0; i < ZOOM_STEPS; i++) { s.dispatchEvent(new WheelEvent('wheel', { deltaY: -40, clientX: ZOOM_X, clientY: ZOOM_Y, bubbles: true, cancelable: true })); await tick(); }
  return s.getAttribute('style');
})()
