export type DisablableHTMLElement = HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

export function getFocusableElements(container: Element | ShadowRoot): HTMLElement[] {
    return Array.from<HTMLElement>(container.querySelectorAll(
        'a[href], button, input, textarea, select, details, [tabindex]:not([tabindex="-1"])'
    )).filter(el => !(<DisablableHTMLElement> el).disabled && el.offsetWidth > 0 && el.offsetHeight > 0 && el.tabIndex !== -1 && el.checkVisibility({checkVisibilityCSS:true}));
}