import { type HTTPRequest, type HTTPResponse } from 'puppeteer-core/lib/esm/puppeteer/puppeteer-core-browser.js';
import type { PageDriver } from './pageDriver';
import { URLNotAllowedError } from './views';

export async function waitForPageLoadState(driver: PageDriver, timeout?: number) {
  const timeoutValue = timeout || 8000;
  await driver.puppeteer?.waitForNavigation({ timeout: timeoutValue });
}

export async function waitForStableNetwork(driver: PageDriver) {
  if (!driver.puppeteer) {
    throw new Error('Puppeteer page is not connected');
  }

  // 招聘官网多是单页应用，岗位和表单内容靠 XHR/fetch 加载；不等它们会在内容渲染前就观察页面。
  const RELEVANT_RESOURCE_TYPES = new Set([
    'document',
    'stylesheet',
    'image',
    'font',
    'script',
    'iframe',
    'xhr',
    'fetch',
  ]);

  const RELEVANT_CONTENT_TYPES = new Set([
    'text/html',
    'text/css',
    'application/javascript',
    'image/',
    'font/',
    'application/json',
  ]);

  const IGNORED_URL_PATTERNS = new Set([
    // Analytics and tracking
    'analytics',
    'tracking',
    'telemetry',
    'beacon',
    'metrics',
    // Ad-related
    'doubleclick',
    'adsystem',
    'adserver',
    'advertising',
    // Social media widgets
    'facebook.com/plugins',
    'platform.twitter',
    'linkedin.com/embed',
    // Live chat and support
    'livechat',
    'zendesk',
    'intercom',
    'crisp.chat',
    'hotjar',
    // Push notifications
    'push-notifications',
    'onesignal',
    'pushwoosh',
    // Background sync/heartbeat
    'heartbeat',
    'ping',
    'alive',
    // WebRTC and streaming
    'webrtc',
    'rtmp://',
    'wss://',
    // Common CDNs
    'cloudfront.net',
    'fastly.net',
  ]);

  const pendingRequests = new Set();
  let lastActivity = Date.now();

  const onRequest = (request: HTTPRequest) => {
    // Filter by resource type
    const resourceType = request.resourceType();
    if (!RELEVANT_RESOURCE_TYPES.has(resourceType)) {
      return;
    }

    // Filter out streaming, websocket, and other real-time requests
    if (['websocket', 'media', 'eventsource', 'manifest', 'other'].includes(resourceType)) {
      return;
    }

    // Filter out by URL patterns
    const url = request.url().toLowerCase();
    if (Array.from(IGNORED_URL_PATTERNS).some(pattern => url.includes(pattern))) {
      return;
    }

    // Filter out data URLs and blob URLs
    if (url.startsWith('data:') || url.startsWith('blob:')) {
      return;
    }

    // Filter out requests with certain headers
    const headers = request.headers();
    if (
      // biome-ignore lint/complexity/useLiteralKeys: <explanation>
      headers['purpose'] === 'prefetch' ||
      headers['sec-fetch-dest'] === 'video' ||
      headers['sec-fetch-dest'] === 'audio'
    ) {
      return;
    }

    pendingRequests.add(request);
    lastActivity = Date.now();
  };

  const onResponse = (response: HTTPResponse) => {
    const request = response.request();
    if (!pendingRequests.has(request)) {
      return;
    }

    // Filter by content type
    const contentType = response.headers()['content-type']?.toLowerCase() || '';

    // Skip streaming content
    if (
      ['streaming', 'video', 'audio', 'webm', 'mp4', 'event-stream', 'websocket', 'protobuf'].some(t =>
        contentType.includes(t),
      )
    ) {
      pendingRequests.delete(request);
      return;
    }

    // Only process relevant content types
    if (!Array.from(RELEVANT_CONTENT_TYPES).some(ct => contentType.includes(ct))) {
      pendingRequests.delete(request);
      return;
    }

    // Skip large responses
    const contentLength = response.headers()['content-length'];
    if (contentLength && Number.parseInt(contentLength) > 5 * 1024 * 1024) {
      // 5MB
      pendingRequests.delete(request);
      return;
    }

    pendingRequests.delete(request);
    lastActivity = Date.now();
  };

  // Add event listeners
  driver.puppeteer.on('request', onRequest);
  driver.puppeteer.on('response', onResponse);

  try {
    const startTime = Date.now();

    // eslint-disable-next-line no-constant-condition
    while (true) {
      await new Promise(resolve => setTimeout(resolve, 100));

      const now = Date.now();
      const timeSinceLastActivity = (now - lastActivity) / 1000; // Convert to seconds

      if (pendingRequests.size === 0 && timeSinceLastActivity >= driver.config.waitForNetworkIdlePageLoadTime) {
        break;
      }

      const elapsedTime = (now - startTime) / 1000; // Convert to seconds
      if (elapsedTime > driver.config.maximumWaitPageLoadTime) {
        console.debug(
          `Network timeout after ${driver.config.maximumWaitPageLoadTime}s with ${pendingRequests.size} pending requests:`,
          Array.from(pendingRequests).map(r => (r as HTTPRequest).url()),
        );
        break;
      }
    }
  } finally {
    // Clean up event listeners
    driver.puppeteer.off('request', onRequest);
    driver.puppeteer.off('response', onResponse);
  }
  console.debug(`Network stabilized for ${driver.config.waitForNetworkIdlePageLoadTime} seconds`);
}

export async function waitForPageAndFramesLoad(driver: PageDriver, timeoutOverwrite?: number): Promise<void> {
  // Start timing
  const startTime = Date.now();

  // Wait for page load
  try {
    // 刚打开的标签页先等文档加载完，否则加载前已发出的数据请求监听不到。按时间轮询：后台标签页不跑 rAF。
    const waitTimeout = Math.min(driver.config.maximumWaitPageLoadTime * 1000, 2500);
    await Promise.race([
      driver.puppeteer
        ?.waitForFunction(() => document.readyState === 'complete', {
          polling: 100,
          timeout: waitTimeout,
        })
        .catch(() => undefined),
      new Promise(resolve => setTimeout(resolve, waitTimeout)),
    ]);
    await waitForStableNetwork(driver);

    // Check if the loaded URL is allowed
    if (driver.puppeteer) {
      await driver.afterNavigation();
    }
  } catch (error) {
    if (error instanceof URLNotAllowedError) {
      throw error;
    }
    console.warn('Page load failed, continuing...', error);
  }

  // Calculate remaining time to meet minimum wait time
  const elapsed = (Date.now() - startTime) / 1000; // Convert to seconds
  const minWaitTime = timeoutOverwrite || driver.config.minimumWaitPageLoadTime;
  const remaining = Math.max(minWaitTime - elapsed, 0);

  console.debug(
    `--Page loaded in ${elapsed.toFixed(2)} seconds, waiting for additional ${remaining.toFixed(2)} seconds`,
  );

  // Sleep remaining time if needed
  if (remaining > 0) {
    await new Promise(resolve => setTimeout(resolve, remaining * 1000)); // Convert seconds to milliseconds
  }
}
