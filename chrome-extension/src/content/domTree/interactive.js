/* global getEventListeners */
export function createInteractionChecks(recruitingRoot, getCachedComputedStyle, isElementVisible) {
  function isInteractiveElement(element) {
    const component = recruitingRoot(element);
    if (component) return component === element;
    if (!element || element.nodeType !== Node.ELEMENT_NODE) {
      return false;
    }

    // Cache the tagName and style lookups
    const tagName = element.tagName.toLowerCase();
    const style = getCachedComputedStyle(element);

    // Define interactive cursors
    const interactiveCursors = new Set([
      'pointer', // Link/clickable elements
      'move', // Movable elements
      'text', // Text selection
      'grab', // Grabbable elements
      'grabbing', // Currently grabbing
      'cell', // Table cell selection
      'copy', // Copy operation
      'alias', // Alias creation
      'all-scroll', // Scrollable content
      'col-resize', // Column resize
      'context-menu', // Context menu available
      'crosshair', // Precise selection
      'e-resize', // East resize
      'ew-resize', // East-west resize
      'help', // Help available
      'n-resize', // North resize
      'ne-resize', // Northeast resize
      'nesw-resize', // Northeast-southwest resize
      'ns-resize', // North-south resize
      'nw-resize', // Northwest resize
      'nwse-resize', // Northwest-southeast resize
      'row-resize', // Row resize
      's-resize', // South resize
      'se-resize', // Southeast resize
      'sw-resize', // Southwest resize
      'vertical-text', // Vertical text selection
      'w-resize', // West resize
      'zoom-in', // Zoom in
      'zoom-out', // Zoom out
    ]);

    // Define non-interactive cursors
    const nonInteractiveCursors = new Set([
      'not-allowed', // Action not allowed
      'no-drop', // Drop not allowed
      'wait', // Processing
      'progress', // In progress
      'initial', // Initial value
      'inherit', // Inherited value
      //? Let's just include all potentially clickable elements that are not specifically blocked
      // 'none',        // No cursor
      // 'default',     // Default cursor
      // 'auto',        // Browser default
    ]);

    /**
     * Checks if an element has an interactive pointer.
     *
     * @param {HTMLElement} element - The element to check.
     * @returns {boolean} Whether the element has an interactive pointer.
     */
    function doesElementHaveInteractivePointer(element) {
      if (element.tagName.toLowerCase() === 'html') return false;

      if (style?.cursor && interactiveCursors.has(style.cursor)) return true;

      return false;
    }

    let isInteractiveCursor = doesElementHaveInteractivePointer(element);

    // Genius fix for almost all interactive elements
    if (isInteractiveCursor) {
      return true;
    }

    const interactiveElements = new Set([
      'a', // Links
      'button', // Buttons
      'input', // All input types (text, checkbox, radio, etc.)
      'select', // Dropdown menus
      'textarea', // Text areas
      'details', // Expandable details
      'summary', // Summary element (clickable part of details)
      'label', // Form labels (often clickable)
      'option', // Select options
      'optgroup', // Option groups
      'fieldset', // Form fieldsets (can be interactive with legend)
      'legend', // Fieldset legends
    ]);

    // Define explicit disable attributes and properties
    const explicitDisableTags = new Set([
      'disabled', // Standard disabled attribute
      // 'aria-disabled',      // ARIA disabled state
      'readonly', // Read-only state
      // 'aria-readonly',     // ARIA read-only state
      // 'aria-hidden',       // Hidden from accessibility
      // 'hidden',            // Hidden attribute
      // 'inert',             // Inert attribute
      // 'aria-inert',        // ARIA inert state
      // 'tabindex="-1"',     // Removed from tab order
      // 'aria-hidden="true"' // Hidden from screen readers
    ]);

    // handle inputs, select, checkbox, radio, textarea, button and make sure they are not cursor style disabled/not-allowed
    if (interactiveElements.has(tagName)) {
      // Check for non-interactive cursor
      if (style?.cursor && nonInteractiveCursors.has(style.cursor)) {
        return false;
      }

      // Check for explicit disable attributes
      for (const disableTag of explicitDisableTags) {
        if (
          element.hasAttribute(disableTag) ||
          element.getAttribute(disableTag) === 'true' ||
          element.getAttribute(disableTag) === ''
        ) {
          return false;
        }
      }

      // Check for disabled property on form elements
      if (element.disabled) {
        return false;
      }

      // Check for readonly property on form elements
      if (element.readOnly) {
        return false;
      }

      // Check for inert property
      if (element.inert) {
        return false;
      }

      return true;
    }

    const role = element.getAttribute('role');
    const ariaRole = element.getAttribute('aria-role');

    // Check for contenteditable attribute
    if (element.getAttribute('contenteditable') === 'true' || element.isContentEditable) {
      return true;
    }

    // Added enhancement to capture dropdown interactive elements
    if (
      element.classList &&
      (element.classList.contains('button') ||
        element.classList.contains('dropdown-toggle') ||
        element.getAttribute('data-index') ||
        element.getAttribute('data-toggle') === 'dropdown' ||
        element.getAttribute('aria-haspopup') === 'true')
    ) {
      return true;
    }

    const interactiveRoles = new Set([
      'button', // Directly clickable element
      // 'link',            // Clickable link
      'menu', // Menu container (ARIA menus)
      'menubar', // Menu bar container
      'menuitem', // Clickable menu item
      'menuitemradio', // Radio-style menu item (selectable)
      'menuitemcheckbox', // Checkbox-style menu item (toggleable)
      'radio', // Radio button (selectable)
      'checkbox', // Checkbox (toggleable)
      'tab', // Tab (clickable to switch content)
      'switch', // Toggle switch (clickable to change state)
      'slider', // Slider control (draggable)
      'spinbutton', // Number input with up/down controls
      'combobox', // Dropdown with text input
      'searchbox', // Search input field
      'textbox', // Text input field
      'listbox', // Selectable list
      'option', // Selectable option in a list
      'scrollbar', // Scrollable control
    ]);

    // Basic role/attribute checks
    const hasInteractiveRole =
      interactiveElements.has(tagName) ||
      (role && interactiveRoles.has(role)) ||
      (ariaRole && interactiveRoles.has(ariaRole));

    if (hasInteractiveRole) return true;

    // check whether element has event listeners by window.getEventListeners
    try {
      if (typeof getEventListeners === 'function') {
        const listeners = getEventListeners(element);
        const mouseEvents = ['click', 'mousedown', 'mouseup', 'dblclick'];
        for (const eventType of mouseEvents) {
          if (listeners[eventType] && listeners[eventType].length > 0) {
            return true; // Found a mouse interaction listener
          }
        }
      }

      const getEventListenersForNode =
        element?.ownerDocument?.defaultView?.getEventListenersForNode || window.getEventListenersForNode;
      if (typeof getEventListenersForNode === 'function') {
        const listeners = getEventListenersForNode(element);
        const interactionEvents = [
          'click',
          'mousedown',
          'mouseup',
          'keydown',
          'keyup',
          'submit',
          'change',
          'input',
          'focus',
          'blur',
        ];
        for (const eventType of interactionEvents) {
          for (const listener of listeners) {
            if (listener.type === eventType) {
              return true; // Found a common interaction listener
            }
          }
        }
      }
      // Fallback: Check common event attributes if getEventListeners is not available (getEventListeners doesn't work in page.evaluate context)
      const commonMouseAttrs = ['onclick', 'onmousedown', 'onmouseup', 'ondblclick'];
      for (const attr of commonMouseAttrs) {
        if (element.hasAttribute(attr) || typeof element[attr] === 'function') {
          return true;
        }
      }
    } catch (e) {
      // console.warn(`Could not check event listeners for ${element.tagName}:`, e);
      // If checking listeners fails, rely on other checks
    }

    return false;
  }

  function isInteractiveCandidate(element) {
    if (recruitingRoot(element)) return true;
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return false;

    const tagName = element.tagName.toLowerCase();

    // Fast-path for common interactive elements
    const interactiveElements = new Set(['a', 'button', 'input', 'select', 'textarea', 'details', 'summary', 'label']);

    if (interactiveElements.has(tagName)) return true;

    // Quick attribute checks without getting full lists
    const hasQuickInteractiveAttr =
      element.hasAttribute('onclick') ||
      element.hasAttribute('role') ||
      element.hasAttribute('tabindex') ||
      element.hasAttribute('aria-') ||
      element.hasAttribute('data-action') ||
      element.getAttribute('contenteditable') === 'true';

    return hasQuickInteractiveAttr;
  }

  const DISTINCT_INTERACTIVE_TAGS = new Set([
    'a',
    'button',
    'input',
    'select',
    'textarea',
    'summary',
    'details',
    'label',
    'option',
  ]);

  const INTERACTIVE_ROLES = new Set([
    'button',
    'link',
    'menuitem',
    'menuitemradio',
    'menuitemcheckbox',
    'radio',
    'checkbox',
    'tab',
    'switch',
    'slider',
    'spinbutton',
    'combobox',
    'searchbox',
    'textbox',
    'listbox',
    'option',
    'scrollbar',
  ]);

  function isHeuristicallyInteractive(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return false;

    // Skip non-visible elements early for performance
    if (!isElementVisible(element)) return false;

    // Check for common attributes that often indicate interactivity
    const hasInteractiveAttributes =
      element.hasAttribute('role') ||
      element.hasAttribute('tabindex') ||
      element.hasAttribute('onclick') ||
      typeof element.onclick === 'function';

    // Check for semantic class names suggesting interactivity
    const hasInteractiveClass = /\b(btn|clickable|menu|item|entry|link)\b/i.test(element.className || '');

    // Determine whether the element is inside a known interactive container
    const isInKnownContainer = Boolean(element.closest('button,a,[role="button"],.menu,.dropdown,.list,.toolbar'));

    // Ensure the element has at least one visible child (to avoid marking empty wrappers)
    const hasVisibleChildren = [...element.children].some(isElementVisible);

    // Avoid highlighting elements whose parent is <body> (top-level wrappers)
    const isParentBody = element.parentElement && element.parentElement.isSameNode(document.body);

    return (
      (isInteractiveElement(element) || hasInteractiveAttributes || hasInteractiveClass) &&
      hasVisibleChildren &&
      isInKnownContainer &&
      !isParentBody
    );
  }

  function isElementDistinctInteraction(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) {
      return false;
    }

    const tagName = element.tagName.toLowerCase();
    const role = element.getAttribute('role');

    // Check if it's an iframe - always distinct boundary
    if (tagName === 'iframe') {
      return true;
    }

    // Check tag name
    if (DISTINCT_INTERACTIVE_TAGS.has(tagName)) {
      return true;
    }
    // Check interactive roles
    if (role && INTERACTIVE_ROLES.has(role)) {
      return true;
    }
    // Check contenteditable
    if (element.isContentEditable || element.getAttribute('contenteditable') === 'true') {
      return true;
    }
    // Check for common testing/automation attributes
    if (element.hasAttribute('data-testid') || element.hasAttribute('data-cy') || element.hasAttribute('data-test')) {
      return true;
    }
    // Check for explicit onclick handler (attribute or property)
    if (element.hasAttribute('onclick') || typeof element.onclick === 'function') {
      return true;
    }

    // return false

    // Check for other common interaction event listeners
    try {
      const getEventListenersForNode =
        element?.ownerDocument?.defaultView?.getEventListenersForNode || window.getEventListenersForNode;
      if (typeof getEventListenersForNode === 'function') {
        const listeners = getEventListenersForNode(element);
        const interactionEvents = [
          'click',
          'mousedown',
          'mouseup',
          'keydown',
          'keyup',
          'submit',
          'change',
          'input',
          'focus',
          'blur',
        ];
        for (const eventType of interactionEvents) {
          for (const listener of listeners) {
            if (listener.type === eventType) {
              return true; // Found a common interaction listener
            }
          }
        }
      }
      // Fallback: Check common event attributes if getEventListeners is not available (getEventListenersForNode doesn't work in page.evaluate context)
      const commonEventAttrs = [
        'onmousedown',
        'onmouseup',
        'onkeydown',
        'onkeyup',
        'onsubmit',
        'onchange',
        'oninput',
        'onfocus',
        'onblur',
      ];
      if (commonEventAttrs.some(attr => element.hasAttribute(attr))) {
        return true;
      }
    } catch (e) {
      // console.warn(`Could not check event listeners for ${element.tagName}:`, e);
      // If checking listeners fails, rely on other checks
    }

    // if the element is not strictly interactive but appears clickable based on heuristic signals
    if (isHeuristicallyInteractive(element)) {
      return true;
    }

    // Default to false: if it's interactive but doesn't match above,
    // assume it triggers the same action as the parent.
    return false;
  }
  return { isInteractiveElement, isInteractiveCandidate, isElementDistinctInteraction };
}
