/* ==========================================================================
 * UNIQLO 四地区商品档案目录 — 前端加载与检索逻辑
 * --------------------------------------------------------------------------
 * 数据全部外置：先读 manifest，再按需读取 summary / taxonomy / 市场索引 /
 * 记录分区。任何商品记录都不写死在 HTML 或本脚本里。
 * 同一个文件在一次会话中只请求一次，结果缓存在内存中。
 * ========================================================================== */
(function () {
  'use strict';

  var FETCH_TIMEOUT_MS = 20000;
  //: 商品目录默认每页 20 条，用户可在分页栏里改（0 = 全部）
  var DEFAULT_PAGE_SIZE = 10;
  var SEARCH_DEBOUNCE_MS = 180;

  /* 允许部署方通过 window.UNIQLO_WEB_CONFIG 覆盖数据根路径（例如 CDN）。 */
  var OVERRIDES = window.UNIQLO_WEB_CONFIG || {};

  var STOCK_LABELS = {
    in_stock: '有货',
    low_stock: '少量',
    out_of_stock: '缺货',
    preorder: '预售',
    not_listed: '未上架',
    unknown: '未知'
  };

  //: 越靠前越"可买"，用于给合并后的商品挑默认 sku
  var STOCK_RANK = {
    in_stock: 0, low_stock: 1, preorder: 2, out_of_stock: 3, not_listed: 4, unknown: 5
  };

  var state = {
    manifest: null,
    summary: null,
    taxonomy: null,
    thumbs: {},
    dataBase: './data/',
    indices: new Map(),      // region -> entries[]
    indexPromises: new Map(),
    partitions: new Map(),   // path -> records[]
    partitionPromises: new Map(),
    records: [],             // 当前筛选后的结果
    groups: [],              // 按商品合并后的结果
    items: [],               // 当前分页实际使用的列表（groups 或 records）
    page: 0,
    pageSize: DEFAULT_PAGE_SIZE,
    categoryQuery: '',
    activeTaxonomyRegion: '',
    collapsed: new Set(),
    ready: false
  };

  /* -------------------------------------------------------------- DOM utils */
  function $(id) { return document.getElementById(id); }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) { node.className = className; }
    if (text !== undefined && text !== null) { node.textContent = String(text); }
    return node;
  }

  function setStatus(node, type, message, retry) {
    if (!node) { return; }
    node.hidden = false;
    node.className = 'status status--' + type;
    var spinner = node.querySelector('.status__spinner');
    if (!spinner && type === 'loading') {
      spinner = el('span', 'status__spinner');
      spinner.setAttribute('aria-hidden', 'true');
      node.insertBefore(spinner, node.firstChild);
    }
    if (spinner && type !== 'loading') { spinner.remove(); }
    var text = node.querySelector('.status__text');
    if (!text) {
      text = el('span', 'status__text');
      node.appendChild(text);
    }
    text.textContent = message;
    var button = node.querySelector('.status__retry');
    if (button) {
      button.hidden = !retry;
      button.onclick = retry || null;
    }
  }

  function hideStatus(node) { if (node) { node.hidden = true; } }

  function formatNumber(value) {
    if (value === null || value === undefined || value === '') { return '—'; }
    var num = Number(value);
    if (!isFinite(num)) { return String(value); }
    return num.toLocaleString('en-US');
  }

  function formatPrice(value, currency) {
    if (value === null || value === undefined || value === '') { return '未提供'; }
    var num = Number(value);
    if (!isFinite(num)) { return '未提供'; }
    return (currency ? currency + ' ' : '') + num.toFixed(2);
  }

  function formatPercent(value) {
    if (value === null || value === undefined) { return '—'; }
    var num = Number(value);
    if (!isFinite(num)) { return '—'; }
    return (num * 100).toFixed(1) + '%';
  }

  function formatTimestamp(value) {
    if (!value) { return '—'; }
    return String(value).replace('T', ' ').replace('Z', ' UTC');
  }

  function textOrUnknown(value) {
    if (value === null || value === undefined || value === '') { return '未提供'; }
    return String(value);
  }

  /* ------------------------------------------------------------- data fetch */
  /**
   * 便携版（portable）说明：
   * 浏览器禁止 file:// 页面用 fetch() 读取同级 JSON，但允许加载 <script>。
   * 便携版把每个 data/*.json 转成同名的 *.js（写入 window.__UQ_DATA 注册表），
   * 本脚本在 portable 模式下改用动态 <script> 按需加载，因此双击 index.html 即可使用。
   */
  var PORTABLE = Boolean(OVERRIDES.portable) ||
    (typeof location !== 'undefined' && location.protocol === 'file:');
  var DATA_REGISTRY = window.__UQ_DATA || (window.__UQ_DATA = {});

  function joinUrl(base, path) {
    if (/^https?:\/\//i.test(path)) { return path; }
    var cleanBase = base.endsWith('/') ? base : base + '/';
    return cleanBase + path.replace(/^\.?\//, '');
  }

  function fetchJson(url, label) {
    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = setTimeout(function () { if (controller) { controller.abort(); } }, FETCH_TIMEOUT_MS);
    var options = { cache: 'no-cache', headers: { Accept: 'application/json' } };
    if (controller) { options.signal = controller.signal; }
    return fetch(url, options)
      .then(function (response) {
        if (!response.ok) {
          throw new Error((label || url) + ' HTTP ' + response.status);
        }
        return response.json();
      })
      .catch(function (error) {
        if (error && error.name === 'AbortError') {
          throw new Error((label || url) + ' 请求超时');
        }
        throw error;
      })
      .finally(function () { clearTimeout(timer); });
  }

  function dataScriptUrl(path) {
    var relative = String(path).replace(/\.json$/i, '') + '.js';
    return joinUrl(state.dataBase, relative);
  }

  function loadScriptData(path, label) {
    if (Object.prototype.hasOwnProperty.call(DATA_REGISTRY, path)) {
      return Promise.resolve(DATA_REGISTRY[path]);
    }
    var url = dataScriptUrl(path);
    return new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      script.src = url;
      script.async = true;
      script.onload = function () {
        script.remove();
        if (Object.prototype.hasOwnProperty.call(DATA_REGISTRY, path)) {
          resolve(DATA_REGISTRY[path]);
        } else {
          reject(new Error((label || path) + ' 未写入数据注册表：' + url));
        }
      };
      script.onerror = function () {
        script.remove();
        reject(new Error((label || path) + ' 加载失败（便携版数据文件缺失）：' + url));
      };
      document.head.appendChild(script);
    });
  }

  function loadData(path, label) {
    if (PORTABLE) { return loadScriptData(path, label); }
    return fetchJson(joinUrl(state.dataBase, path), label);
  }

  function loadManifest() {
    if (PORTABLE) {
      return loadScriptData('manifest.json', 'manifest.json').then(function (manifest) {
        return acceptManifest(manifest);
      });
    }
    var manifestUrl = OVERRIDES.manifest_url || './data/manifest.json';
    return fetchJson(manifestUrl, 'manifest.json').then(acceptManifest);
  }

  function acceptManifest(manifest) {
    if (!manifest || manifest.total_records === undefined) {
      throw new Error('manifest.json 缺少必要字段');
    }
    if (manifest.schema_version !== 1) {
      throw new Error('不支持的数据版本 schema_version=' + manifest.schema_version);
    }
    state.manifest = manifest;
    state.dataBase = OVERRIDES.data_base_url || manifest.data_base_url || './data/';
    return manifest;
  }

  function loadSummary() {
    return loadData('summary.json', 'summary.json').then(function (summary) {
      state.summary = summary;
      return summary;
    });
  }

  function loadTaxonomy() {
    return loadData('taxonomy.json', 'taxonomy.json').then(function (taxonomy) {
      state.taxonomy = taxonomy;
      return taxonomy;
    });
  }

  function loadThumbnails() {
    // 缩略图清单很小（每个商品一条），随总览一起加载；图片本身按需懒加载
    return loadData('thumbnails.json', '商品缩略图清单')
      .then(function (map) {
        state.thumbs = map || {};
        return state.thumbs;
      })
      .catch(function () {
        state.thumbs = {};
        return {};
      });
  }

  function thumbnailFor(entry) {
    var key = (entry.region_code || '') + '|' +
      (entry.product_url_key || entry.cn_product_code || '');
    var info = state.thumbs[key];
    if (!info) { return ''; }
    if (info.local) { return './' + info.local; }
    return info.url || '';
  }

  function loadRegionIndex(region) {
    if (!region) { return Promise.resolve([]); }
    if (state.indices.has(region)) { return Promise.resolve(state.indices.get(region)); }
    if (state.indexPromises.has(region)) { return state.indexPromises.get(region); }
    var meta = (state.manifest.search_index || []).filter(function (item) {
      return item.region_code === region;
    })[0];
    // a large market index may be sharded so no single file exceeds the host limit
    var parts = (meta && meta.parts && meta.parts.length)
      ? meta.parts
      : [meta ? meta.path : 'search-index/' + region + '.json'];
    var promise = parts.reduce(function (chain, part) {
      return chain.then(function (acc) {
        return loadData(part, '搜索索引 ' + region).then(function (entries) {
          return acc.concat(Array.isArray(entries) ? entries : []);
        });
      });
    }, Promise.resolve([]))
      .then(function (list) {
        state.indices.set(region, list);
        state.indexPromises.delete(region);
        return list;
      })
      .catch(function (error) {
        state.indexPromises.delete(region);
        throw error;
      });
    state.indexPromises.set(region, promise);
    return promise;
  }

  function ensureIndices() {
    var selected = $('filter-market').value;
    var regions = selected
      ? [selected]
      : (state.manifest.markets || []).map(function (market) { return market.code; });
    return Promise.all(regions.map(function (region) {
      return loadRegionIndex(region).catch(function (error) {
        // 单个市场索引缺失不应阻断其他市场
        console.warn(error);
        if (state.indices.has(region)) { return state.indices.get(region); }
        state.indices.set(region, []);
        return [];
      });
    }));
  }

  function loadPartition(path) {
    if (!path) { return Promise.reject(new Error('记录缺少分区路径')); }
    if (state.partitions.has(path)) { return Promise.resolve(state.partitions.get(path)); }
    if (state.partitionPromises.has(path)) { return state.partitionPromises.get(path); }
    var promise = loadData(path, '记录分区 ' + path)
      .then(function (records) {
        var list = Array.isArray(records) ? records : [];
        state.partitions.set(path, list);
        state.partitionPromises.delete(path);
        return list;
      })
      .catch(function (error) {
        state.partitionPromises.delete(path);
        throw error;
      });
    state.partitionPromises.set(path, promise);
    return promise;
  }

  /* --------------------------------------------------------------- bootstrap */
  function bootstrap() {
    setStatus($('global-status'), 'loading', '正在加载数据清单 manifest…');
    loadManifest()
      .then(function (manifest) {
        setStatus($('global-status'), 'loading', '正在加载总览与分类体系…');
        return Promise.all([loadSummary(), loadTaxonomy(), loadThumbnails()])
          .then(function () { return manifest; });
      })
      .then(function (manifest) {
        state.ready = true;
        hideStatus($('global-status'));
        var portableNote = $('portable-note');
        if (portableNote && PORTABLE) { portableNote.hidden = false; }
        renderMasthead(manifest);
        renderFacts();
        renderOverview();
        renderTaxonomyTabs();
        renderTaxonomy(state.taxonomy && state.taxonomy.regions && state.taxonomy.regions[0]
          ? state.taxonomy.regions[0].code : '');
        setStatus($('global-status'), 'loading', '正在加载搜索索引…');
        return ensureIndices().then(function () {
          hideStatus($('global-status'));
          applyFilters();
        });
      })
      .catch(function (error) {
        console.error(error);
        setStatus($('global-status'), 'error', '数据文件加载失败：' + error.message, bootstrap);
        var summary = $('results-summary');
        if (summary) { summary.textContent = '数据加载失败，请点击上方“重试”。'; }
      });
  }

  /* ----------------------------------------------------------------- render */
  function renderMasthead(manifest) {
    $('meta-generated').textContent = formatTimestamp(manifest.generated_at);
    $('meta-markets').textContent = (manifest.markets || []).map(function (market) {
      return market.code;
    }).join(' / ') || '—';
    $('meta-records').textContent = formatNumber(manifest.total_records);
    var products = state.summary && state.summary.totals ? state.summary.totals.products : null;
    $('meta-products').textContent = formatNumber(products);
    $('footer-generated').textContent = formatTimestamp(manifest.generated_at);
    if (manifest.downloads && manifest.downloads.workbook) {
      $('download-workbook').setAttribute('href', './' + manifest.downloads.workbook);
      $('download-workbook').hidden = false;
    } else {
      // hosted without the workbook (e.g. host caps a file at 25 MiB)
      var download = $('download-workbook');
      if (download) { download.hidden = true; }
    }

    var select = $('filter-market');
    while (select.options.length > 1) { select.remove(1); }
    (manifest.markets || []).forEach(function (market) {
      var option = el('option', null, market.code + ' · ' + market.name);
      option.value = market.code;
      select.appendChild(option);
    });
  }

  function renderFacts() {
    var warnings = (state.summary && state.summary.completeness_warnings) || [];
    var box = $('completeness');
    var list = $('completeness-list');
    list.textContent = '';
    if (!warnings.length) { box.hidden = true; return; }
    warnings.forEach(function (warning) { list.appendChild(el('li', null, warning)); });
    box.hidden = false;
  }

  function card(label, value, note) {
    var wrap = el('div', 'card');
    wrap.appendChild(el('p', 'card__label', label));
    wrap.appendChild(el('p', 'card__value', value));
    if (note) { wrap.appendChild(el('p', 'card__note', note)); }
    return wrap;
  }

  function renderOverview() {
    var summary = state.summary || {};
    var totals = summary.totals || {};
    var cards = $('overview-cards');
    cards.textContent = '';
    cards.appendChild(card('变体记录', formatNumber(totals.variants), '市场 × 商品 × 颜色 × 尺码'));
    cards.appendChild(card('商品款式', formatNumber(totals.products), '按市场内商品代码去重'));
    cards.appendChild(card('价格覆盖率', formatPercent(totals.price_coverage), '有明确价格的变体占比'));
    cards.appendChild(card('市场数', formatNumber((summary.markets || []).length), '本期覆盖 UK / AU / US / CN'));

    var tbody = $('market-table-body');
    tbody.textContent = '';
    (summary.markets || []).forEach(function (market) {
      var tr = el('tr');
      tr.appendChild(el('td', null, market.code + ' · ' + market.name));
      var statusCell = el('td');
      var badge = el('span', 'tag', market.status || 'unknown');
      if (market.status === 'ok') { badge.classList.add('tag--market'); }
      statusCell.appendChild(badge);
      tr.appendChild(statusCell);
      tr.appendChild(el('td', null, market.currency_code || '—'));
      var variants = el('td', 'num', formatNumber(market.variants));
      tr.appendChild(variants);
      tr.appendChild(el('td', 'num', formatNumber(market.products_discovered)));
      tr.appendChild(el('td', 'num', formatPercent(market.price_coverage)));
      tr.appendChild(el('td', 'num', formatPercent(market.stock_coverage)));
      var note = el('td', 'muted', (market.notes && market.notes[0]) || market.robots_note || '—');
      tr.appendChild(note);
      tbody.appendChild(tr);
    });

    renderBarList($('stock-distribution'), summary.by_stock_status || {}, function (key) {
      return (STOCK_LABELS[key] || key) + ' (' + key + ')';
    });
    renderBarList($('department-distribution'), summary.by_department || {}, function (key) {
      return key;
    });
    var departments = Object.keys(summary.by_department || {});
    var deptSelect = $('filter-department');
    while (deptSelect.options.length > 1) { deptSelect.remove(1); }
    departments.forEach(function (name) {
      var option = el('option', null, name);
      option.value = name;
      deptSelect.appendChild(option);
    });
  }

  function renderBarList(node, data, labeler) {
    node.textContent = '';
    var entries = Object.keys(data).map(function (key) { return [key, data[key]]; });
    if (!entries.length) { node.appendChild(el('li', 'muted', '暂无数据')); return; }
    entries.sort(function (a, b) { return b[1] - a[1]; });
    var max = entries[0][1] || 1;
    entries.slice(0, 8).forEach(function (pair) {
      var li = el('li');
      li.appendChild(el('span', null, labeler(pair[0])));
      var bar = el('span', 'bar');
      var fill = el('span');
      fill.style.width = Math.max(2, Math.round((pair[1] / max) * 100)) + '%';
      bar.appendChild(fill);
      li.appendChild(bar);
      li.appendChild(el('span', 'value', formatNumber(pair[1])));
      node.appendChild(li);
    });
  }

  function renderTaxonomyTabs() {
    var tabs = $('taxonomy-tabs');
    tabs.textContent = '';
    var regions = (state.taxonomy && state.taxonomy.regions) || [];
    regions.forEach(function (region) {
      var button = el('button', null, region.code + ' · ' + region.name);
      button.type = 'button';
      button.setAttribute('role', 'tab');
      button.dataset.region = region.code;
      button.setAttribute('aria-selected', 'false');
      button.addEventListener('click', function () {
        renderTaxonomy(region.code);
      });
      tabs.appendChild(button);
    });
  }

  function renderTaxonomy(regionCode) {
    if (!regionCode) {
      $('taxonomy-tree').textContent = '暂无分类数据。';
      return;
    }
    state.activeTaxonomyRegion = regionCode;
    Array.prototype.forEach.call($('taxonomy-tabs').children, function (button) {
      button.setAttribute('aria-selected', button.dataset.region === regionCode ? 'true' : 'false');
    });
    var region = ((state.taxonomy && state.taxonomy.regions) || []).filter(function (item) {
      return item.code === regionCode;
    })[0];
    var host = $('taxonomy-tree');
    host.textContent = '';
    if (!region || !region.nodes || !region.nodes.length) {
      host.appendChild(el('p', 'muted', '该市场暂无已确认的分类节点。'));
      return;
    }
    host.appendChild(buildTree(region.nodes, 0));
  }

  function buildTree(nodes, depth, ancestors) {
    var root = el('ul');
    ancestors = ancestors || [];
    if (depth === 0) { root.setAttribute('role', 'tree'); }
    nodes.forEach(function (node) {
      var li = el('li');
      li.setAttribute('role', 'treeitem');
      var row = el('div', 'tree__row');
      var kids = node.children || [];
      var toggle = el('button', 'tree__toggle', kids.length ? '−' : '+');
      toggle.type = 'button';
      toggle.disabled = !kids.length;
      row.appendChild(toggle);
      var label = el('button', 'tree__label', node.name);
      label.type = 'button';
      label.title = '在目录中筛选该分类';
      label.addEventListener('click', function () {
        filterByCategoryChain(ancestors.concat([node]));
        document.getElementById('catalogue').scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      row.appendChild(label);
      row.appendChild(el('span', 'tree__level', 'L' + (node.level || depth + 1)));
      row.appendChild(el('span', 'tree__count', formatNumber(node.record_count) + ' 件'));
      if (node.listing_url) {
        var link = el('a', 'tree__external', '官网分类页 ↗');
        link.href = node.listing_url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        row.appendChild(link);
      }
      li.appendChild(row);
      if (kids.length) {
        // 大类（L1）默认收起，更深的层级默认展开
        var collapsed = depth === 0;
        var child = buildTree(kids, depth + 1, ancestors.concat([node]));
        child.hidden = collapsed;
        li.appendChild(child);
        toggle.textContent = collapsed ? '+' : '−';
        toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
        toggle.addEventListener('click', function () {
          var opened = child.hidden;
          child.hidden = !opened;
          toggle.textContent = opened ? '−' : '+';
          toggle.setAttribute('aria-expanded', opened ? 'true' : 'false');
        });
      }
      root.appendChild(li);
    });
    return root;
  }

  /* ---------------------------------------------------------------- filters */
  function readFilters() {
    return {
      q: ($('filter-q').value || '').trim().toLowerCase(),
      market: $('filter-market').value,
      department: $('filter-department').value,
      stock: $('filter-stock').value,
      color: $('filter-color').value,
      size: $('filter-size').value,
      category: ($('filter-category').value || '').trim().toLowerCase(),
      priceMin: parseFloat($('filter-price-min').value),
      priceMax: parseFloat($('filter-price-max').value),
      sort: $('filter-sort').value,
      grouped: $('group-products') ? $('group-products').checked : true
    };
  }

  function haystackOf(entry) {
    if (entry.__hay) { return entry.__hay; }
    var text = [
      entry.product_name, entry.product_url_key, entry.cn_product_code,
      entry.cn_variant_code, entry.official_sku, entry.official_l2_id,
      entry.color_name, entry.color_display_code, entry.size_label,
      entry.size_display_code, entry.category_path, entry.category_paths,
      entry.variant_key
    ].join(' ').toLowerCase();
    try { entry.__hay = text; } catch (error) { /* frozen object: ignore */ }
    return text;
  }

  function matches(entry, filters) {
    if (filters.market && entry.region_code !== filters.market) { return false; }
    if (filters.department && entry.department !== filters.department) { return false; }
    if (filters.stock && (entry.stock_status || 'unknown') !== filters.stock) { return false; }
    if (filters.color && (entry.color_display_code || '') !== filters.color) { return false; }
    if (filters.size && (entry.size_display_code || '') !== filters.size) { return false; }
    if (filters.category) {
      if (!categoryMatches(entry, filters.category)) { return false; }
    }
    if (!isNaN(filters.priceMin) || !isNaN(filters.priceMax)) {
      var price = entry.price_current;
      if (price === null || price === undefined) { return false; }
      if (!isNaN(filters.priceMin) && Number(price) < filters.priceMin) { return false; }
      if (!isNaN(filters.priceMax) && Number(price) > filters.priceMax) { return false; }
    }
    if (filters.q) {
      var haystack = haystackOf(entry);
      var terms = filters.q.split(/\s+/).filter(Boolean);
      for (var i = 0; i < terms.length; i += 1) {
        if (haystack.indexOf(terms[i]) === -1) { return false; }
      }
    }
    return true;
  }

  function sortRecords(records, filters) {
    var copy = records.slice();
    var singleMarket = Boolean(filters.market);
    switch (filters.sort) {
      case 'name':
        copy.sort(function (a, b) {
          return String(a.product_name || '').localeCompare(String(b.product_name || ''), 'en');
        });
        break;
      case 'price_asc':
        if (!singleMarket) { return copy; }
        copy.sort(function (a, b) { return numOr(a.price_current, Infinity) - numOr(b.price_current, Infinity); });
        break;
      case 'price_desc':
        if (!singleMarket) { return copy; }
        copy.sort(function (a, b) { return numOr(b.price_current, -Infinity) - numOr(a.price_current, -Infinity); });
        break;
      case 'captured_desc':
        copy.sort(function (a, b) {
          return String(b.captured_at_utc || '').localeCompare(String(a.captured_at_utc || ''));
        });
        break;
      case 'stock':
        copy.sort(function (a, b) {
          return String(a.stock_status || '').localeCompare(String(b.stock_status || ''));
        });
        break;
      default:
        break;
    }
    return copy;
  }

  function numOr(value, fallback) {
    var num = Number(value);
    return isFinite(num) ? num : fallback;
  }

  /* --------------------------------------------------- category path matching */
  function splitPaths(entry) {
    var raw = entry.category_paths || entry.category_path || '';
    var list = String(raw).split('|').map(function (part) { return part.trim(); })
      .filter(Boolean);
    if (entry.category_path && list.indexOf(String(entry.category_path).trim()) === -1) {
      list.unshift(String(entry.category_path).trim());
    }
    return list;
  }

  function pathSegments(path) {
    return String(path || '').split('>').map(function (part) {
      return part.trim().toLowerCase();
    }).filter(Boolean);
  }

  /**
   * 「男装 > 内衣 · 内裤 · 袜子」这类查询必须按**整条路径**匹配。
   * 只比对叶子名会把其它部门下同名分类的商品一起捞出来
   * （例如女装 > 内衣 · 内裤 · 袜子）。
   * 不带 ">" 的输入仍然是宽松的子串匹配，便于自由检索。
   */
  function categoryMatches(entry, query) {
    var q = String(query || '').trim().toLowerCase();
    if (!q) { return true; }
    var paths = splitPaths(entry);
    if (!paths.length) { return false; }
    if (q.indexOf('>') === -1) {
      for (var i = 0; i < paths.length; i += 1) {
        if (paths[i].toLowerCase().indexOf(q) !== -1) { return true; }
      }
      var primary = String(entry.category_path || '').toLowerCase();
      return primary.indexOf(q) !== -1;
    }
    return Boolean(matchedCategoryPath(entry, q));
  }

  /** 返回该记录里与查询匹配的那条完整分类路径（用于结果展示）。 */
  function matchedCategoryPath(entry, query) {
    var q = String(query || '').trim().toLowerCase();
    var paths = splitPaths(entry);
    if (!q) { return ''; }
    if (q.indexOf('>') === -1) {
      for (var i = 0; i < paths.length; i += 1) {
        if (paths[i].toLowerCase().indexOf(q) !== -1) { return paths[i]; }
      }
      return '';
    }
    var wanted = pathSegments(q);
    for (var p = 0; p < paths.length; p += 1) {
      var segments = pathSegments(paths[p]);
      for (var start = 0; start + wanted.length <= segments.length; start += 1) {
        var hit = true;
        for (var j = 0; j < wanted.length; j += 1) {
          if (segments[start + j] !== wanted[j]) { hit = false; break; }
        }
        if (hit) { return paths[p]; }
      }
    }
    return '';
  }

  function refreshIndicesThenFilter() {
    var filters = readFilters();
    setStatus($('global-status'), 'loading', '正在加载所选市场的搜索索引…');
    return ensureIndices()
      .then(function () {
        hideStatus($('global-status'));
        applyFilters(filters);
      })
      .catch(function (error) {
        console.error(error);
        setStatus($('global-status'), 'error', '搜索索引加载失败：' + error.message, function () {
          refreshIndicesThenFilter();
        });
      });
  }

  /**
   * 分类树的点击筛选。
   *
   * 有些分类页的名字不会出现在任何商品的 category_path 里：
   *   · 站点会为「系列 / 合集」单开一页（例如 CN 的 T恤·卫衣·摇粒绒系列），
   *     商品只记在最具体的那个分类下；
   *   · 只走到 L2 的采集不会产生 L3 路径。
   * 此时直接按该名字筛选会得到 0 条，所以逐级回退到最近一个有结果的上级分类，
   * 并明确告诉用户"显示的是上级分类"。
   */
  function filterByCategoryChain(chain) {
    var index = chain.length - 1;
    function chainPath(upto) {
      // 用整条路径（含部门）作为筛选条件，避免"男装-内衣"命中"女装-内衣"
      return chain.slice(0, upto + 1).map(function (node) { return node.name; }).join(' > ');
    }
    function attempt() {
      var node = chain[index];
      $('filter-category').value = chainPath(index);
      $('filter-market').value = state.activeTaxonomyRegion;
      return refreshIndicesThenFilter().then(function () {
        if (state.records.length > 0 || index === 0) {
          var fellBack = index !== chain.length - 1;
          setCategoryNote(fellBack
            ? '「' + chainPath(chain.length - 1) + '」没有独立商品记录，已显示上级分类「' +
              chainPath(index) + '」的结果。'
            : '');
          renderResults();
          return;
        }
        index -= 1;
        return attempt();
      });
    }
    setCategoryNote('');
    return attempt();
  }

  function setCategoryNote(text) {
    var note = $('category-note');
    if (!note) { return; }
    note.textContent = text || '';
    note.hidden = !text;
  }

  /* ------------------------------------------------------ facet options ---- */
  function facetCounts(pool, codeField) {
    var map = new Map();
    pool.forEach(function (entry) {
      var code = entry[codeField];
      if (!code) { return; }
      var item = map.get(code);
      if (!item) {
        item = { value: String(code), label: String(code), count: 0 };
        map.set(code, item);
      }
      item.count += 1;
    });
    return Array.from(map.values());
  }

  /** 颜色/尺码下拉的显示文字：名称 · 代码（没有名称时只显示代码）。 */
  function facetLabels(pool, codeField, nameField) {
    var names = new Map();
    pool.forEach(function (entry) {
      var code = entry[codeField];
      if (!code || names.has(code)) { return; }
      names.set(code, String(entry[nameField] || '').trim());
    });
    return names;
  }

  function fillFacet(select, allLabel, items, names, current) {
    names = names || new Map();
    select.textContent = '';
    var all = document.createElement('option');
    all.value = '';
    all.textContent = allLabel;
    select.appendChild(all);
    items.forEach(function (item) {
      var option = document.createElement('option');
      option.value = item.value;
      var name = names.get(item.value) || '';
      option.textContent = (name ? name + ' · ' : '') + item.value +
        '（' + formatNumber(item.count) + '）';
      select.appendChild(option);
    });
    select.value = current || '';
    if (select.value !== (current || '')) { select.value = ''; }
    return select.value;
  }

  function applyFilters(precomputed) {
    var filters = precomputed || readFilters();
    var regions = filters.market
      ? [filters.market]
      : Array.from(state.indices.keys());
    var pool = [];
    regions.forEach(function (region) {
      pool = pool.concat(state.indices.get(region) || []);
    });

    // 颜色/尺码的候选项必须来自"当前其它条件筛选之后"的真实交集，
    // 每个分面在统计自己时忽略自己的取值（标准分面行为）
    var withoutColor = Object.assign({}, filters, { color: '' });
    var withoutSize = Object.assign({}, filters, { size: '' });
    var colorPool = pool.filter(function (entry) { return matches(entry, withoutColor); });
    var sizePool = pool.filter(function (entry) { return matches(entry, withoutSize); });
    var colorItems = facetCounts(colorPool, 'color_display_code');
    var sizeItems = facetCounts(sizePool, 'size_display_code');
    var colorNames = facetLabels(colorPool, 'color_display_code', 'color_name');
    var sizeNames = facetLabels(sizePool, 'size_display_code', 'size_label');

    if (filters.color && !colorItems.some(function (i) { return i.value === filters.color; })) {
      filters.color = '';
    }
    if (filters.size && !sizeItems.some(function (i) { return i.value === filters.size; })) {
      filters.size = '';
    }
    filters.color = fillFacet($('filter-color'), '全部颜色', colorItems, colorNames, filters.color);
    filters.size = fillFacet($('filter-size'), '全部尺码', sizeItems, sizeNames, filters.size);

    var matched = pool.filter(function (entry) { return matches(entry, filters); });
    state.records = sortRecords(matched, filters);
    state.groups = filters.grouped ? groupRecords(state.records) : [];
    state.items = filters.grouped ? state.groups : state.records;
    state.categoryQuery = filters.category || '';
    state.page = 0;
    $('price-scope-hint').hidden = Boolean(filters.market) || filters.sort.indexOf('price') !== 0;
    renderResults();
  }

  /* ------------------------------------------------- product-level grouping - */
  function stockRank(entryOrStatus) {
    var status = typeof entryOrStatus === 'string'
      ? entryOrStatus
      : (entryOrStatus && entryOrStatus.stock_status) || 'unknown';
    var rank = STOCK_RANK[status];
    return rank === undefined ? 9 : rank;
  }

  function betterVariant(candidate, current) {
    if (!current) { return true; }
    var rankA = stockRank(candidate);
    var rankB = stockRank(current);
    if (rankA !== rankB) { return rankA < rankB; }
    var priceA = Number(candidate.price_current);
    var priceB = Number(current.price_current);
    if (isFinite(priceA) && isFinite(priceB) && priceA !== priceB) { return priceA < priceB; }
    return false;
  }

  function groupRecords(records) {
    var order = [];
    var map = new Map();
    records.forEach(function (entry) {
      var key = (entry.region_code || '') + '|' +
        (entry.product_url_key || entry.cn_product_code || entry.variant_key);
      var group = map.get(key);
      if (!group) {
        group = {
          key: key, records: [], colors: [], sizes: [],
          names: { color: new Map(), size: new Map() }, matrix: {}
        };
        map.set(key, group);
        order.push(key);
      }
      group.records.push(entry);
      var color = entry.color_display_code || '';
      var size = entry.size_display_code || '';
      if (!group.matrix[color]) {
        group.colors.push(color);
        group.matrix[color] = {};
        group.names.color.set(color, String(entry.color_name || '').trim());
      }
      if (group.sizes.indexOf(size) === -1) {
        group.sizes.push(size);
        group.names.size.set(size, String(entry.size_label || '').trim());
      }
      var existing = group.matrix[color][size];
      if (!existing || betterVariant(entry, existing)) {
        group.matrix[color][size] = entry;
      }
    });
    return order.map(function (key) { return map.get(key); });
  }

  function bestVariant(group) {
    var best = null;
    group.records.forEach(function (entry) {
      if (betterVariant(entry, best)) { best = entry; }
    });
    return best || group.records[0];
  }

  function bestSizeForColor(group, color, preferred) {
    var row = group.matrix[color] || {};
    if (preferred && row[preferred]) { return preferred; }
    var best = null;
    group.sizes.forEach(function (size) {
      var entry = row[size];
      if (!entry) { return; }
      if (!best || betterVariant(entry, row[best])) { best = size; }
    });
    return best;
  }

  function renderResults() {
    var list = $('entries');
    var empty = $('empty-state');
    list.textContent = '';
    var items = state.items || state.records;
    var total = items.length;
    var pageSize = state.pageSize > 0 ? state.pageSize : Math.max(total, 1);
    var pages = Math.max(1, Math.ceil(total / pageSize));
    if (state.page >= pages) { state.page = pages - 1; }
    if (state.page < 0) { state.page = 0; }
    var start = state.page * pageSize;
    var end = Math.min(total, start + pageSize);
    var grouped = Boolean(state.groups && state.groups.length);
    for (var i = start; i < end; i += 1) {
      list.appendChild(grouped ? renderEntry(null, items[i]) : renderEntry(items[i]));
    }
    var variants = state.records.length;
    var summary;
    if (!total) {
      summary = '没有匹配的记录。';
    } else if (grouped) {
      summary = '匹配 ' + formatNumber(variants) + ' 条变体 / ' + formatNumber(total) +
        ' 个商品，当前显示第 ' + formatNumber(start + 1) + '–' + formatNumber(end) + ' 个商品。';
    } else {
      summary = '匹配 ' + formatNumber(variants) + ' 条变体记录，当前显示第 ' +
        formatNumber(start + 1) + '–' + formatNumber(end) + ' 条。';
    }
    $('results-summary').textContent = summary;
    $('page-indicator').textContent = '第 ' + formatNumber(state.page + 1) + ' / ' +
      formatNumber(pages) + ' 页';
    $('page-prev').disabled = state.page <= 0;
    $('page-first').disabled = state.page <= 0;
    $('page-next').disabled = state.page >= pages - 1;
    $('page-last').disabled = state.page >= pages - 1;
    var jump = $('page-jump');
    jump.max = String(pages);
    jump.value = total ? String(state.page + 1) : '';
    jump.disabled = pages <= 1;
    empty.hidden = total > 0;
  }

  function goToPage(page) {
    var total = (state.items || state.records).length;
    var pageSize = state.pageSize > 0 ? state.pageSize : Math.max(total, 1);
    var pages = Math.max(1, Math.ceil(total / pageSize));
    state.page = Math.min(Math.max(0, page), pages - 1);
    renderResults();
    var host = $('results');
    if (host && host.scrollIntoView) {
      host.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  function variantTabRow(label, values, names, dotOf) {
    var row = el('div', 'variant-row');
    row.appendChild(el('span', 'variant-row__label', label));
    var tabs = el('div', 'variant-tabs');
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', label);
    values.forEach(function (value) {
      var button = el('button', 'variant-tab');
      button.type = 'button';
      button.setAttribute('role', 'tab');
      button.dataset.value = value;
      var name = names.get(value) || '';
      button.textContent = name || value || '未提供';
      button.title = (name ? name + ' · ' : '') + (value || '未提供');
      if (dotOf) {
        var stock = dotOf(value);
        var dot = el('span', 'variant-tab__dot');
        dot.classList.add('is-' + (stock || 'unavailable'));
        button.appendChild(dot);
      }
      tabs.appendChild(button);
    });
    row.appendChild(tabs);
    return row;
  }

  function renderEntry(entry, group) {
    var template = $('entry-template');
    var node = template.content.firstElementChild.cloneNode(true);
    var link = node.querySelector('.entry__link');
    var marketTag = node.querySelector('.tag--market');
    var stockTag = node.querySelector('.tag--stock');
    var priceTag = node.querySelector('.tag--price');
    var official = node.querySelector('.entry__official');
    var toggle = node.querySelector('.entry__toggle');
    var detail = node.querySelector('.entry__detail');
    var thumb = node.querySelector('.entry__thumb');
    var availability = null;

    var selection = null;
    if (group) {
      var seed = bestVariant(group);
      selection = {
        color: seed.color_display_code || '',
        size: seed.size_display_code || ''
      };
    }

    function currentEntry() {
      if (!group) { return entry; }
      var row = group.matrix[selection.color] || {};
      return row[selection.size] || bestVariant(group);
    }

    function refresh() {
      var current = currentEntry();
      var stock = current.stock_status || 'unknown';
      node.setAttribute('data-stock', stock);
      node.className = node.className.replace(/\s*\bentry--stock-\S+/g, '');
      node.classList.add('entry--stock-' + stock);

      link.href = current.variant_url || current.product_url || '#';
      link.textContent = textOrUnknown(current.product_name || current.product_url_key);
      link.target = '_blank';
      link.rel = 'noopener noreferrer';

      marketTag.textContent = current.region_code || '—';
      stockTag.textContent = (STOCK_LABELS[stock] || stock) + ' · ' + stock;
      stockTag.className = 'tag tag--stock is-' + stock;
      priceTag.textContent = formatPrice(current.price_current, current.currency_code);

      node.querySelector('.entry__code').textContent =
        textOrUnknown(current.product_url_key || current.cn_product_code);
      var vcodeWrap = node.querySelector('.entry__vcode-wrap');
      var vcode = current.cn_variant_code || current.official_l2_id || '';
      if (vcode) {
        vcodeWrap.hidden = false;
        node.querySelector('.entry__vcode').textContent = vcode;
      } else {
        vcodeWrap.hidden = true;
      }
      node.querySelector('.entry__color').textContent =
        (current.color_name || '未提供') + ' · ' + textOrUnknown(current.color_display_code);
      node.querySelector('.entry__size').textContent =
        (current.size_label || '未提供') + ' · ' + textOrUnknown(current.size_display_code);

      var paths = splitPaths(current);
      var shownPath = matchedCategoryPath(current, state.categoryQuery) || current.category_path;
      var categoryCell = node.querySelector('.entry__category');
      categoryCell.textContent = textOrUnknown(shownPath);
      if (paths.length > 1) {
        categoryCell.textContent += '（共 ' + paths.length + ' 个分类）';
        categoryCell.title = paths.join('\n');
      }
      node.querySelector('.entry__key').textContent = textOrUnknown(current.variant_key);
      node.querySelector('.entry__captured').textContent = formatTimestamp(current.captured_at_utc);
      official.href = current.product_url || link.href;

      // 缩略图：列表渲染时才真正开始下载（loading=lazy 再加一层），
      // 已下架商品的图片随站点一起发布，仍在售的走官网地址
      var thumbSrc = thumbnailFor(current);
      if (thumb && thumbSrc) {
        if (thumb.getAttribute('src') !== thumbSrc) {
          thumb.dataset.fallback = '';
          var info = state.thumbs[(current.region_code || '') + '|' +
            (current.product_url_key || current.cn_product_code || '')] || {};
          if (info.fallback) { thumb.dataset.fallback = info.fallback; }
          thumb.onerror = function () {
            var fallback = thumb.dataset.fallback;
            if (fallback) {
              thumb.dataset.fallback = '';
              thumb.setAttribute('src', fallback);
              return;
            }
            thumb.hidden = true;
            node.classList.add('entry--no-thumb');
          };
          thumb.setAttribute('src', thumbSrc);
          thumb.hidden = false;
        }
        node.classList.remove('entry--no-thumb');
      } else if (thumb) {
        thumb.hidden = true;
        node.classList.add('entry--no-thumb');
      }

      if (availability) {
        var colorName = group.names.color.get(selection.color) || selection.color || '未提供';
        var sizeName = group.names.size.get(selection.size) || selection.size || '未提供';
        availability.textContent = '当前选择：' + colorName + ' · ' + sizeName + ' — ' +
          (STOCK_LABELS[stock] || stock);
        availability.className = 'entry__availability is-' + stock;
      }

      // 切换选项卡后，完整记录需要跟着换
      if (detail.dataset.loaded) {
        delete detail.dataset.loaded;
        if (!detail.hidden) { detail.textContent = '正在加载完整记录…'; loadDetail(); }
      }
    }

    function loadDetail() {
      var current = currentEntry();
      loadPartition(current.partition)
        .then(function (records) {
          var record = records.filter(function (item) {
            return item.variant_key === current.variant_key;
          })[0];
          detail.dataset.loaded = '1';
          detail.textContent = '';
          if (!record) {
            detail.appendChild(el('p', 'muted', '该记录不在声明分区中，请重新构建网页数据。'));
            return;
          }
          detail.appendChild(buildDetailTable(record));
        })
        .catch(function (error) {
          detail.textContent = '';
          var message = el('p', 'status status--error',
            '记录分区加载失败：' + error.message + '（请检查文件是否存在后重试）');
          detail.appendChild(message);
          var retry = el('button', 'button button--ghost', '重试加载');
          retry.type = 'button';
          retry.addEventListener('click', function () {
            delete detail.dataset.loaded;
            detail.textContent = '正在加载完整记录…';
            loadDetail();
          });
          detail.appendChild(retry);
        });
    }

    if (group && (group.colors.length > 1 || group.sizes.length > 1)) {
      var block = el('div', 'entry__variants');
      var colorRow = variantTabRow('颜色', group.colors, group.names.color, function (color) {
        var row = group.matrix[color] || {};
        var best = null;
        Object.keys(row).forEach(function (size) {
          if (!best || betterVariant(row[size], row[best])) { best = size; }
        });
        return best ? (row[best].stock_status || 'unknown') : 'unavailable';
      });
      var sizeRow = variantTabRow('尺码', group.sizes, group.names.size, function (size) {
        var record = (group.matrix[selection.color] || {})[size];
        return record ? (record.stock_status || 'unknown') : 'unavailable';
      });
      block.appendChild(colorRow);
      block.appendChild(sizeRow);
      availability = el('p', 'entry__availability');
      block.appendChild(availability);
      node.querySelector('.entry__meta').before(block);

      // 颜色/尺码已在选项卡里表达，隐藏原表格行避免重复
      Array.prototype.forEach.call(node.querySelectorAll('.entry__meta > div'), function (row) {
        var label = row.querySelector('dt');
        if (label && (label.textContent === '颜色' || label.textContent === '尺码')) {
          row.hidden = true;
        }
      });

      function paint() {
        Array.prototype.forEach.call(colorRow.querySelectorAll('.variant-tab'), function (button) {
          var on = button.dataset.value === selection.color;
          button.classList.toggle('is-selected', on);
          button.setAttribute('aria-selected', on ? 'true' : 'false');
        });
        Array.prototype.forEach.call(sizeRow.querySelectorAll('.variant-tab'), function (button) {
          var on = button.dataset.value === selection.size;
          button.classList.toggle('is-selected', on);
          button.setAttribute('aria-selected', on ? 'true' : 'false');
          var record = (group.matrix[selection.color] || {})[button.dataset.value];
          button.classList.toggle('is-unavailable', !record);
          var dot = button.querySelector('.variant-tab__dot');
          if (dot) {
            dot.className = 'variant-tab__dot is-' + (record ? (record.stock_status || 'unknown') : 'unavailable');
          }
        });
      }

      colorRow.addEventListener('click', function (event) {
        var button = event.target.closest ? event.target.closest('.variant-tab') : null;
        if (!button) { return; }
        selection.color = button.dataset.value;
        var nextSize = bestSizeForColor(group, selection.color, selection.size);
        if (nextSize) { selection.size = nextSize; }
        paint();
        refresh();
      });
      sizeRow.addEventListener('click', function (event) {
        var button = event.target.closest ? event.target.closest('.variant-tab') : null;
        if (!button) { return; }
        var size = button.dataset.value;
        if (!(group.matrix[selection.color] || {})[size]) {
          // 该尺码在当前颜色下没有，切到第一个有它的颜色
          var alternative = group.colors.filter(function (color) {
            return (group.matrix[color] || {})[size];
          });
          if (!alternative.length) { return; }
          selection.color = alternative[0];
        }
        selection.size = size;
        paint();
        refresh();
      });
      paint();
    }

    toggle.addEventListener('click', function () {
      if (!detail.hidden) {
        detail.hidden = true;
        toggle.textContent = '展开完整记录';
        toggle.setAttribute('aria-expanded', 'false');
        return;
      }
      detail.hidden = false;
      toggle.textContent = '收起完整记录';
      toggle.setAttribute('aria-expanded', 'true');
      if (!detail.dataset.loaded) {
        detail.textContent = '正在加载完整记录…';
        loadDetail();
      }
    });

    refresh();
    return node;
  }

  var DETAIL_FIELDS = [
    ['variant_key', 'variant_key（自建键）'],
    ['official_sku', 'official_sku（官方 l2 标识）'],
    ['official_communication_code', 'official_communication_code'],
    ['official_l2_id', 'official_l2_id'],
    ['cn_variant_code', 'cn_variant_code（变体级）'],
    ['product_url_key', 'product_url_key'],
    ['primary_display_product_id', 'primary_display_product_id'],
    ['display_product_ids', 'display_product_ids'],
    ['cn_product_code', 'cn_product_code'],
    ['region_name', 'region_name'],
    ['locale', 'locale'],
    ['currency_code', 'currency_code'],
    ['department', 'department'],
    ['category_path', 'category_path（主分类）'],
    ['category_paths', 'category_paths（全部所属分类）'],
    ['size_type', 'size_type'],
    ['price_current', 'price_current'],
    ['price_original', 'price_original'],
    ['price_sale', 'price_sale'],
    ['lowest_price_30d', 'lowest_price_30d'],
    ['price_text', 'price_text'],
    ['discount_percent', 'discount_percent'],
    ['is_listed', 'is_listed'],
    ['stock_status', 'stock_status'],
    ['is_purchasable', 'is_purchasable'],
    ['stock_quantity', 'stock_quantity'],
    ['availability_note', 'availability_note'],
    ['captured_at_utc', 'captured_at_utc'],
    ['source_method', 'source_method'],
    ['parse_status', 'parse_status'],
    ['missing_fields', 'missing_fields'],
    ['source_listing_url', 'source_listing_url'],
    ['canonical_url', 'canonical_url'],
    ['main_image_url', 'main_image_url'],
    ['material', 'material'],
    ['product_description', 'product_description']
  ];

  function buildDetailTable(record) {
    var table = el('table');
    var tbody = el('tbody');
    DETAIL_FIELDS.forEach(function (pair) {
      var value = record[pair[0]];
      if (value === null || value === undefined || value === '') { value = '未提供'; }
      var tr = el('tr');
      tr.appendChild(el('th', null, pair[1]));
      var td = el('td');
      if (pair[0] === 'product_url' || pair[0] === 'source_listing_url' ||
          pair[0] === 'canonical_url' || pair[0] === 'main_image_url') {
        var link = el('a', null, String(value));
        link.href = String(value);
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        td.appendChild(link);
      } else {
        td.textContent = String(value);
      }
      tr.appendChild(td);
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    return table;
  }

  /* ------------------------------------------------------------------ events */
  function debounce(fn, wait) {
    var handle = null;
    return function () {
      var args = arguments;
      var context = this;
      clearTimeout(handle);
      handle = setTimeout(function () { fn.apply(context, args); }, wait);
    };
  }

  function wireEvents() {
    $('filter-q').addEventListener('input', debounce(function () { applyFilters(); }, SEARCH_DEBOUNCE_MS));
    $('filter-category').addEventListener('input', debounce(function () { applyFilters(); }, SEARCH_DEBOUNCE_MS));
    $('filter-price-min').addEventListener('input', debounce(function () { applyFilters(); }, SEARCH_DEBOUNCE_MS));
    $('filter-price-max').addEventListener('input', debounce(function () { applyFilters(); }, SEARCH_DEBOUNCE_MS));
    ['filter-market', 'filter-department', 'filter-stock', 'filter-sort',
     'filter-color', 'filter-size', 'group-products'].forEach(function (id) {
      $(id).addEventListener('change', function () {
        if (id === 'filter-market') {
          refreshIndicesThenFilter();
        } else {
          applyFilters();
        }
      });
    });
    $('filter-reset').addEventListener('click', function () {
      $('filter-q').value = '';
      $('filter-category').value = '';
      $('filter-price-min').value = '';
      $('filter-price-max').value = '';
      $('filter-department').value = '';
      $('filter-stock').value = '';
      $('filter-color').value = '';
      $('filter-size').value = '';
      $('filter-sort').value = 'relevance';
      if ($('group-products')) { $('group-products').checked = true; }
      applyFilters();
    });
    $('page-size').addEventListener('change', function () {
      var size = parseInt($('page-size').value, 10);
      state.pageSize = isNaN(size) ? DEFAULT_PAGE_SIZE : size;
      state.page = 0;
      renderResults();
    });
    $('page-first').addEventListener('click', function () { goToPage(0); });
    $('page-prev').addEventListener('click', function () { goToPage(state.page - 1); });
    $('page-next').addEventListener('click', function () { goToPage(state.page + 1); });
    $('page-last').addEventListener('click', function () {
      var total = state.records.length;
      var pageSize = state.pageSize > 0 ? state.pageSize : Math.max(total, 1);
      goToPage(Math.max(0, Math.ceil(total / pageSize) - 1));
    });
    $('page-jump').addEventListener('change', function () {
      var target = parseInt($('page-jump').value, 10);
      if (!isNaN(target)) { goToPage(target - 1); } else { renderResults(); }
    });
    $('page-jump').addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        var target = parseInt($('page-jump').value, 10);
        if (!isNaN(target)) { goToPage(target - 1); }
      }
    });
    $('global-retry').addEventListener('click', bootstrap);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      wireEvents();
      bootstrap();
    });
  } else {
    wireEvents();
    bootstrap();
  }
})();

