(async () => {
  const s = document.querySelector('#dot-diagram svg');
  if (!s) return 'no svg';
  const box = s.parentElement.getBoundingClientRect();
  const wheel = (dy) => s.dispatchEvent(new WheelEvent('wheel', { deltaY: dy, clientX: box.left + 8, clientY: box.top + 8, bubbles: true, cancelable: true }));
  const tick = () => new Promise((r) => setTimeout(r, 120));
  for (let i = 0; i < 80 && s.getBoundingClientRect().width > box.width * 0.97; i++) { wheel(30); await tick(); }
  for (let i = 0; i < 80 && s.getBoundingClientRect().width < box.width * 0.85; i++) { wheel(-15); await tick(); }
  return [s.getAttribute('style'), s.getBoundingClientRect().width, box.width];
})()
