// ==UserScript==
// @name         IKEA 3D Model Downloader
// @namespace    http://tampermonkey.net/
// @version      2.2
// @description  Adds a native-looking download button for 3D models on IKEA product pages
// @match        https://*.ikea.com/*/p/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // -------- Utilities --------------------------------------------------------
  function isGlbUrl(u) {
    return !!u && (u.includes('.glb') || u.includes('glb_draco'));
  }

  // -------- Capture GLB requests --------------------------------------------
  window.mUrls = [];

  const ORIGINAL_FETCH = window.fetch;
  window.fetch = function () {
    const url = arguments[0]?.toString();
    if (isGlbUrl(url)) window.mUrls.push(url);
    return ORIGINAL_FETCH.apply(this, arguments);
  };

  const ORIGINAL_XHR_OPEN = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function () {
    const url = arguments[1]?.toString();
    if (isGlbUrl(url)) window.mUrls.push(url);
    return ORIGINAL_XHR_OPEN.apply(this, arguments);
  };

  if (window.PerformanceObserver) {
    try {
      const perfObserver = new PerformanceObserver((list) => {
        list.getEntries().forEach((entry) => {
          if (isGlbUrl(entry.name)) window.mUrls.push(entry.name);
        });
      });
      perfObserver.observe({ entryTypes: ['resource'] });
    } catch (e) { /* ignore */ }
  }

  // -------- DOM wiring -------------------------------------------------------
  function onDomReady() {
    ensureDownloadButton();
    let currentUrl = location.href;

    // React to SPA navigation changes.
    new MutationObserver(() => {
      if (location.href !== currentUrl) {
        currentUrl = location.href;
        window.mUrls = [];
        ensureDownloadButton();
      }
    }).observe(document, { subtree: true, childList: true });

    // Track <model-viewer> creation and src changes.
    const body = document.body;
    if (!body) return;
    const mvObserver = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes || []) {
          if (node.nodeType !== 1 || !node.querySelector) continue;
          if (node.nodeName === 'MODEL-VIEWER') observeModelViewer(node);
          node.querySelectorAll('model-viewer').forEach(observeModelViewer);
        }
      }
    });
    mvObserver.observe(body, { childList: true, subtree: true });
  }

  function observeModelViewer(mv) {
    const src = mv.getAttribute('src');
    if (isGlbUrl(src)) window.mUrls.push(src);

    const attrObserver = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.attributeName === 'src') {
          const newSrc = mv.getAttribute('src');
          if (isGlbUrl(newSrc)) window.mUrls.push(newSrc);
        }
      }
    });
    attrObserver.observe(mv, { attributes: true });
  }

  // -------- Button creation (native-looking) --------------------------------
  let retryCount = 0;
  const maxRetries = 15;

  function ensureDownloadButton() {
    const sourceButton = document.querySelector('.pip-xr-button');
    if (!sourceButton) {
      retryCount++;
      if (retryCount < maxRetries) setTimeout(ensureDownloadButton, 1000);
      return;
    }
    retryCount = 0;
    if (document.getElementById('i-m-d-btn')) return;

    const downloadButton = cloneNativeButton(sourceButton);
    sourceButton.parentNode.insertBefore(downloadButton, sourceButton.nextSibling);

    // Mirror state from the native button.
    const mirror = () => {
      downloadButton.disabled = sourceButton.disabled;
      downloadButton.className = sourceButton.className;
      downloadButton.id = 'i-m-d-btn'; // keep our id after class copy
    };
    mirror();
    const btnObserver = new MutationObserver(mirror);
    btnObserver.observe(sourceButton, { attributes: true, attributeFilter: ['class', 'disabled', 'aria-disabled'] });
  }

  function cloneNativeButton(sourceButton) {
    const btn = sourceButton.cloneNode(true);
    btn.id = 'i-m-d-btn';
    btn.type = 'button';
    btn.setAttribute('aria-label', getLocalizedLabel());
    btn.setAttribute('data-automation-id', 'pip-download-3d');

    // Label
    const labelEl =
      btn.querySelector('.pip-btn__label') ||
      btn.querySelector('[class*="btn__label"]') ||
      btn;
    labelEl.textContent = getLocalizedLabel();

    // Icon
    let svg = btn.querySelector('svg');
    if (!svg) {
      svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      const inner = btn.querySelector('.pip-btn__inner') || btn;
      inner.insertBefore(svg, inner.firstChild);
    }
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '24');
    svg.setAttribute('height', '24');
    svg.setAttribute('aria-hidden', 'true');
    svg.classList.add('pip-svg-icon', 'pip-btn__icon');
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z'); // download icon
    svg.appendChild(path);

    // Remove any inline handlers from clone and attach our own.
    btn.removeAttribute('onclick');
    btn.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      handleDownload(sourceButton);
    });

    return btn;
  }

  function getLocalizedLabel() {
    const url = window.location.href;
    const map = {
      'fi/fi': 'Lataa 3D',
      'se/sv': 'Ladda ned 3D',
      'fr/fr': 'Télécharger 3D',
      'es/es': 'Descargar 3D',
      'it/it': 'Scarica 3D',
      'no/no': 'Last ned 3D',
      'pl/pl': 'Pobierz 3D',
      'pt/pt': 'Transferir 3D',
      'jp/ja': '3Dをダウンロード',
      'kr/ko': '3D 다운로드',
      'cn/zh': '下载3D模型',
      'ae/ar': 'تنزيل ثلاثي الأبعاد'
    };
    for (const [k, v] of Object.entries(map)) if (url.includes(`ikea.com/${k}/`)) return v;
    return 'Download 3D model';
  }

  // -------- Download flow ----------------------------------------------------
  function handleDownload(triggerButton) {
    if (window.mUrls.length > 0) {
      startDownload(window.mUrls[window.mUrls.length - 1]);
      return;
    }

    const viewers = document.querySelectorAll('model-viewer');
    for (const v of viewers) {
      const src = v.getAttribute('src');
      if (isGlbUrl(src)) { startDownload(src); return; }
    }

    // Ask IKEA’s viewer to load, then poll for URLs.
    triggerButton.click();
    pollForResources();
  }

  function pollForResources() {
    let attempts = 0;
    const timer = setInterval(() => {
      attempts++;

      if (window.mUrls.length > 0) {
        clearInterval(timer);
        startDownload(window.mUrls[window.mUrls.length - 1]);
        return;
      }

      const viewers = document.querySelectorAll('model-viewer');
      for (const v of viewers) {
        const src = v.getAttribute('src');
        if (isGlbUrl(src)) {
          clearInterval(timer);
          startDownload(src);
          return;
        }
      }

      scanIframesForModels();

      if (attempts >= 30) {
        clearInterval(timer);
        alert('Error downloading model. Please refresh and try again.');
      }
    }, 500);
  }

  function scanIframesForModels() {
    const iframes = document.querySelectorAll('iframe');
    for (const frame of iframes) {
      try {
        if (!frame.contentDocument) continue;
        const nodes = frame.contentDocument.querySelectorAll('model-viewer, a-entity[gltf-model]');
        for (const el of nodes) {
          const src = el.getAttribute('src') || el.getAttribute('gltf-model');
          if (isGlbUrl(src)) window.mUrls.push(src);
        }
      } catch (e) { /* cross-origin, ignore */ }
    }
  }

  function startDownload(modelUrl) {
    fetch(modelUrl).then((res) => res.blob()).then((blob) => {
      const fileBlob = new Blob([blob], { type: 'application/octet-stream' });
      const link = document.createElement('a');
      link.href = window.URL.createObjectURL(fileBlob);

      // Build filename: "<Product Name> - <Variant> (<ID>).glb"
      const titleEl = document.querySelector('title');
      let productName = 'ikea_product';
      let variant = '';
      if (titleEl) {
        const t = titleEl.textContent.trim();
        const parts = t.split(' - IKEA')[0].split(',');
        productName = parts[0].trim();
        if (parts.length > 1) variant = parts[1].trim();
      }
      let productId = '';
      const idMatch = modelUrl.match(/\/(\d+)_/) || modelUrl.match(/\/(\d+)\//);
      if (idMatch?.[1]) productId = idMatch[1];

      let fileName = productName;
      if (variant) fileName += ' - ' + variant;
      if (productId) fileName += ' (' + productId + ')';
      link.download = fileName.replace(/[<>:"\/\\|?*]/g, '') + '.glb';

      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }).catch((e) => {
      alert('Error downloading model: ' + e.message);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', onDomReady);
  } else {
    onDomReady();
  }
})();
