import { createGeometryCache } from './geometry';
import { createXPathReader } from './xpath';
import { createVisibilityChecks } from './visibility';
import { createInteractionChecks } from './interactive';
import { HIGHLIGHT_CONTAINER_ID, createHighlighter } from './highlight';

window.buildDomTree = (
  args = {
    showHighlightElements: true,
    focusHighlightIndex: -1,
    viewportExpansion: 0,
    debugMode: false,
    startId: 0,
    startHighlightIndex: 0,
  },
) => {
  const { showHighlightElements, focusHighlightIndex, viewportExpansion, startHighlightIndex, startId } = args;
  const recruitingRoots = (args.recruitingAdapters || [])
    .map(adapter => adapter.root)
    .filter(Boolean)
    .join(', ');
  const recruitingRoot = element => (recruitingRoots && element?.closest ? element.closest(recruitingRoots) : null);
  const recruitingOptions = (args.recruitingAdapters || [])
    .map(adapter => adapter.option)
    .filter(Boolean)
    .join(', ');
  const geometry = createGeometryCache();
  const { getCachedBoundingRect, getCachedComputedStyle, DOM_CACHE } = geometry;
  const { getXPathTree } = createXPathReader();
  const { isTextNodeVisible, isElementAccepted, isElementVisible, isTopElement, isInExpandedViewport } =
    createVisibilityChecks(viewportExpansion, geometry);
  const { isInteractiveElement, isInteractiveCandidate, isElementDistinctInteraction } = createInteractionChecks(
    recruitingRoot,
    getCachedComputedStyle,
    isElementVisible,
  );
  const { handleHighlighting } = createHighlighter(
    showHighlightElements,
    focusHighlightIndex,
    startHighlightIndex,
    viewportExpansion,
    isElementDistinctInteraction,
    isInExpandedViewport,
  );
  const DOM_HASH_MAP = {};

  const ID = { current: startId };
  /**
   * Creates a node data object for a given node and its descendants.
   *
   * @param {HTMLElement} node - The node to process.
   * @param {HTMLElement | null} parentIframe - The parent iframe node.
   * @param {boolean} isParentHighlighted - Whether the parent node is highlighted.
   * @returns {string | null} The ID of the node data object, or null if the node is not processed.
   */
  const MAX_DEPTH = 100;
  let visitedNodes;

  function buildDomTree(node, parentIframe = null, isParentHighlighted = false, depth = 0) {
    // Initialize visited nodes tracking on first call
    if (!visitedNodes) {
      visitedNodes = new WeakSet();
    }

    // Prevent infinite recursion
    if (depth > MAX_DEPTH) {
      return null;
    }

    // Fast rejection checks first
    if (
      !node ||
      node.id === HIGHLIGHT_CONTAINER_ID ||
      node.id === 'qz-agent-feedback' ||
      node.id === 'qz-agent-viewport-glow' ||
      node.id === 'qz-agent-field-focus' ||
      node.id === 'qz-agent-floating-entry' ||
      (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.TEXT_NODE)
    ) {
      return null;
    }

    // Prevent circular references (only for valid nodes)
    if (node.nodeType === Node.ELEMENT_NODE && visitedNodes.has(node)) {
      return null;
    }
    if (node.nodeType === Node.ELEMENT_NODE) {
      visitedNodes.add(node);
    }

    // Special handling for root node (body) across main document and same-origin iframes
    if (node === (node.ownerDocument?.body ?? document.body)) {
      const nodeData = {
        tagName: 'body',
        attributes: {},
        xpath: '/body',
        children: [],
      };

      // Process children of body
      for (const child of Array.from(node.childNodes)) {
        const domElement = buildDomTree(child, parentIframe, false, depth + 1); // Body's children have no highlighted parent initially
        if (domElement) nodeData.children.push(domElement);
      }

      const id = `${ID.current++}`;
      DOM_HASH_MAP[id] = nodeData;
      return id;
    }

    // Early bailout for non-element nodes except text
    if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.TEXT_NODE) {
      return null;
    }

    // Process text nodes
    if (node.nodeType === Node.TEXT_NODE) {
      const textContent = node.textContent?.trim();
      if (!textContent) {
        return null;
      }

      // Only check visibility for text nodes that might be visible
      const parentElement = node.parentElement;
      if (!parentElement || parentElement.tagName.toLowerCase() === 'script') {
        return null;
      }

      const id = `${ID.current++}`;
      DOM_HASH_MAP[id] = {
        type: 'TEXT_NODE',
        text: textContent,
        isVisible: isTextNodeVisible(node),
      };
      return id;
    }

    // Quick checks for element nodes
    if (node.nodeType === Node.ELEMENT_NODE && !isElementAccepted(node)) {
      return null;
    }

    // Early viewport check - only filter out elements clearly outside viewport
    // The getBoundingClientRect() of the Shadow DOM host element may return width/height = 0
    if (viewportExpansion !== -1 && !node.shadowRoot) {
      const rect = getCachedBoundingRect(node); // Keep for initial quick check
      const style = getCachedComputedStyle(node);

      // Skip viewport check for fixed/sticky elements as they may appear anywhere
      const isFixedOrSticky = style && (style.position === 'fixed' || style.position === 'sticky');

      // Check if element has actual dimensions using offsetWidth/Height (quick check)
      const hasSize = node.offsetWidth > 0 || node.offsetHeight > 0;

      // Use getBoundingClientRect for the quick OUTSIDE check.
      // isInExpandedViewport will do the more accurate check later if needed.
      if (
        !rect ||
        (!isFixedOrSticky &&
          !hasSize &&
          (rect.bottom < -viewportExpansion ||
            rect.top > window.innerHeight + viewportExpansion ||
            rect.right < -viewportExpansion ||
            rect.left > window.innerWidth + viewportExpansion))
      ) {
        // console.log("Skipping node outside viewport (quick check):", node.tagName, rect);
        return null;
      }
    }

    /**
     * @type {
      {
          tagName: string;
          attributes: Record<string, string | null>;
          xpath: any;
          children: never[];
          isVisible?: boolean;
          isTopElement?: boolean;
          isInteractive?: boolean;
          isInViewport?: boolean;
          highlightIndex?: number;
          shadowRoot?: boolean;
      }
    } nodeData - The node data object.
     */
    const nodeData = {
      tagName: node.tagName.toLowerCase(),
      attributes: {},
      xpath: getXPathTree(node, true),
      children: [],
    };

    // Get attributes for interactive elements or potential text containers
    if (
      isInteractiveCandidate(node) ||
      (recruitingOptions && node.matches(recruitingOptions)) ||
      node.hasAttribute('aria-required') ||
      node.hasAttribute('aria-invalid') ||
      node.tagName.toLowerCase() === 'iframe' ||
      node.tagName.toLowerCase() === 'body'
    ) {
      const attributeNames = node.getAttributeNames?.() || [];
      for (const name of attributeNames) {
        const value = node.getAttribute(name);
        nodeData.attributes[name] = value;
      }
      if (recruitingOptions && node.matches(recruitingOptions)) nodeData.attributes['data-qz-option'] = 'true';
      const component = recruitingRoot(node);
      if (component === node) nodeData.attributes['data-qz-control'] = 'combobox';
      else if (component) nodeData.attributes['data-qz-control-part'] = 'true';
      // Markup attributes keep initial state; typed text and toggles live on properties.
      // Tag names rather than instanceof: same-origin iframe controls belong to another realm.
      const controlTag = node.tagName.toLowerCase();
      if (controlTag === 'input' || controlTag === 'textarea' || controlTag === 'select') {
        if (node.disabled || node.matches(':disabled')) nodeData.attributes.disabled = 'true';
        else delete nodeData.attributes.disabled;
        if (node.readOnly) nodeData.attributes.readonly = 'true';
        else delete nodeData.attributes.readonly;
        if (node.required) nodeData.attributes.required = 'true';
        else delete nodeData.attributes.required;
        const controlType = (node.type || '').toLowerCase();
        if (controlType === 'checkbox' || controlType === 'radio') nodeData.attributes.checked = String(node.checked);
        // React mirrors controlled values into the attribute, passwords included.
        else if (controlType === 'password') delete nodeData.attributes.value;
        else nodeData.attributes.value = node.value;
      } else if (
        node.isContentEditable ||
        ['', 'true', 'plaintext-only'].includes(node.getAttribute('contenteditable') ?? 'false')
      ) {
        nodeData.attributes.value = node.textContent ?? '';
      } else if (
        !node.textContent?.trim() &&
        !node.getAttribute('aria-label') &&
        !node.getAttribute('title') &&
        !node.querySelector('input, select, textarea')
      ) {
        // 没有文字的图标按钮：交出图标名，没有就交出去掉哈希后缀的末尾类名，由模型判断用途（删除、编辑等）。
        const icons = [node, ...node.querySelectorAll('[data-icon], use')]
          .map(
            el =>
              el.getAttribute('data-icon') ||
              (el.getAttribute('href') || el.getAttribute('xlink:href') || '').replace(/^#/, ''),
          )
          .filter(Boolean);
        const classes = (node.getAttribute('class') || '')
          .split(/\s+/)
          .filter(Boolean)
          .slice(-2)
          .map(token => token.replace(/(?:__|-)[A-Za-z0-9]{5,}$/, ''));
        const hint = [...new Set(icons.length ? icons : classes)].join(' ').slice(0, 60);
        if (hint) nodeData.attributes.hint = hint;
      }
    }

    let nodeWasHighlighted = false;
    // Perform visibility, interactivity, and highlighting checks
    if (node.nodeType === Node.ELEMENT_NODE) {
      nodeData.isVisible = isElementVisible(node); // isElementVisible uses offsetWidth/Height, which is fine
      if (nodeData.isVisible) {
        nodeData.isTopElement = isTopElement(node);

        // Special handling for ARIA menu containers - check interactivity even if not top element
        const role = node.getAttribute('role');
        const isMenuContainer = role === 'menu' || role === 'menubar' || role === 'listbox';

        if (nodeData.isTopElement || isMenuContainer) {
          nodeData.isInteractive = isInteractiveElement(node);
          // Call the dedicated highlighting function
          nodeWasHighlighted = handleHighlighting(nodeData, node, parentIframe, isParentHighlighted);
        }
      }
    }

    // Process children, with special handling for iframes and rich text editors
    if (node.tagName) {
      const tagName = node.tagName.toLowerCase();

      // Handle iframes
      if (tagName === 'iframe') {
        const rect = getCachedBoundingRect(node);
        nodeData.attributes['computedHeight'] = String(Math.ceil(rect.height));
        nodeData.attributes['computedWidth'] = String(Math.ceil(rect.width));

        // Check if iframe should be skipped (invisible tracking/ad iframes)
        const shouldSkipIframe =
          // Invisible iframes (1x1 pixel or similar)
          (rect.width <= 1 && rect.height <= 1) ||
          // Positioned off-screen
          rect.left < -1000 ||
          rect.top < -1000;

        // Early detection for sandboxed iframes
        const sandbox = node.getAttribute('sandbox');
        const isSandboxed = sandbox !== null;
        const isRestrictiveSandbox = isSandboxed && !sandbox.includes('allow-same-origin');

        if (shouldSkipIframe) {
          // Skip processing invisible/tracking iframes entirely
          nodeData.attributes['skipped'] = 'invisible-tracking-iframe';
        } else if (isRestrictiveSandbox) {
          // Set error directly for sandboxed iframes we know will fail
          nodeData.attributes['error'] = 'Cross-origin iframe access blocked by sandbox';
        } else {
          // Only attempt access for iframes that might succeed
          try {
            const iframeDoc = node.contentDocument || node.contentWindow?.document;
            if (iframeDoc && iframeDoc.childNodes) {
              for (const child of Array.from(iframeDoc.childNodes)) {
                const domElement = buildDomTree(child, node, false, depth + 1);
                if (domElement) nodeData.children.push(domElement);
              }
            }
          } catch (e) {
            nodeData.attributes['error'] = e.message;
            // Only log unexpected errors, not predictable ones
            if (!e.message.includes('cross-origin') && !e.message.includes('origin "null"')) {
              console.warn('Unable to access iframe:', e);
            }
          }
        }
      }
      // Handle rich text editors and contenteditable elements
      else if (
        node.isContentEditable ||
        node.getAttribute('contenteditable') === 'true' ||
        node.id === 'tinymce' ||
        node.classList.contains('mce-content-body') ||
        (tagName === 'body' && node.getAttribute('data-id')?.startsWith('mce_'))
      ) {
        // Process all child nodes to capture formatted text
        for (const child of Array.from(node.childNodes)) {
          const domElement = buildDomTree(child, parentIframe, nodeWasHighlighted, depth + 1);
          if (domElement) nodeData.children.push(domElement);
        }
      } else {
        // Handle shadow DOM
        if (node.shadowRoot) {
          nodeData.shadowRoot = true;
          for (const child of Array.from(node.shadowRoot.childNodes)) {
            const domElement = buildDomTree(child, parentIframe, nodeWasHighlighted, depth + 1);
            if (domElement) nodeData.children.push(domElement);
          }
        }
        // Handle regular elements
        for (const child of Array.from(node.childNodes)) {
          // Pass the highlighted status of the *current* node to its children
          const passHighlightStatusToChild = nodeWasHighlighted || isParentHighlighted;
          const domElement = buildDomTree(child, parentIframe, passHighlightStatusToChild, depth + 1);
          if (domElement) nodeData.children.push(domElement);
        }
      }
    }

    // Skip empty anchor tags only if they have no dimensions and no children
    if (nodeData.tagName === 'a' && nodeData.children.length === 0 && !nodeData.attributes.href) {
      // Check if the anchor has actual dimensions
      const rect = getCachedBoundingRect(node);
      const hasSize = (rect && rect.width > 0 && rect.height > 0) || node.offsetWidth > 0 || node.offsetHeight > 0;

      if (!hasSize) {
        return null;
      }
    }

    const id = `${ID.current++}`;
    DOM_HASH_MAP[id] = nodeData;
    return id;
  }

  // Reset visited nodes for new DOM tree build
  visitedNodes = null;
  const rootId = buildDomTree(document.body);

  // Clear the cache before starting
  DOM_CACHE.clearCache();

  return { rootId, map: DOM_HASH_MAP };
};
