// Like BB's submit button, act on touch release rather than relying on the
// compatibility click. A layout change can retarget that click to another
// control, so catch it on the document even if the toggle has unmounted.
export function suppressTouchCompatibilityClick(ownerDocument: Document): void {
  const clear = () => {
    window.clearTimeout(timeout);
    ownerDocument.removeEventListener("click", handleClick, true);
    ownerDocument.removeEventListener("pointerdown", clear, true);
    ownerDocument.removeEventListener("keydown", clear, true);
  };
  const handleClick = (event: MouseEvent) => {
    // Keyboard and assistive-technology activation must remain available.
    if (event.detail === 0) return;
    clear();
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const timeout = window.setTimeout(clear, 1000);
  ownerDocument.addEventListener("click", handleClick, true);
  ownerDocument.addEventListener("pointerdown", clear, true);
  ownerDocument.addEventListener("keydown", clear, true);
}
