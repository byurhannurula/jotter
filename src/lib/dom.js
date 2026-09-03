// One element builder for the DOM main.js assembles by hand (settings
// sections, sidebar rows, tabs, context menu, switcher, toasts).

/**
 * Build an element.
 *
 *   el("button", { class: "prompt-btn", text: "Save", on: { click: save } })
 *   el("li", { class: "row", data: { id }, aria: { selected: "true" } }, child, ...)
 *
 * `class`, `text`, `html` and `role` are the usual shorthands; `aria` and
 * `data` take objects; `on` takes listeners by event name. Any other key is
 * set as a property (`id`, `type`, `title`, `hidden`, `tabIndex`, `disabled`,
 * `placeholder`, `spellcheck`...). `undefined` and `null` values are skipped.
 * Children are appended in order; strings become text nodes.
 */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "html") node.innerHTML = value;
    else if (key === "role") node.setAttribute("role", value);
    else if (key === "aria") {
      for (const [name, v] of Object.entries(value)) node.setAttribute(`aria-${name}`, v);
    } else if (key === "data") Object.assign(node.dataset, value);
    else if (key === "on") {
      for (const [event, fn] of Object.entries(value)) node.addEventListener(event, fn);
    } else node[key] = value;
  }
  node.append(...children);
  return node;
}
