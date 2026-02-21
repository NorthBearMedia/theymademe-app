// tree-cards.js — Interactive card-based family tree view
// Pure vanilla JS, no dependencies

(function () {
  'use strict';

  // Confidence colour map (matching fan-chart.js)
  var COLORS = {
    verified:      { bg: '#d4edda', border: '#27ae60', text: '#155724' },
    probable:      { bg: '#d6eaf8', border: '#2980b9', text: '#1a5276' },
    possible:      { bg: '#fff3cd', border: '#f39c12', text: '#856404' },
    suggested:     { bg: '#fce4ec', border: '#e91e63', text: '#880e4f' },
    customer_data: { bg: '#e8daef', border: '#8e44ad', text: '#6c3483' },
    empty:         { bg: '#faf6f0', border: '#d5cec2', text: '#999' },
  };

  function colorForAncestor(a) {
    if (!a) return COLORS.empty;
    var s = a.confidence_score || 0;
    var lvl = (a.confidence_level || '').toLowerCase().replace(/\s+/g, '_');
    if (lvl === 'customer_data') return COLORS.customer_data;
    if (s >= 90) return COLORS.verified;
    if (s >= 75) return COLORS.probable;
    if (s >= 50) return COLORS.possible;
    if (s > 0 || a.fs_person_id) return COLORS.suggested;
    return COLORS.empty;
  }

  // Relationship to subject using ahnentafel path tracing
  function getRelationToSubject(ascNum) {
    if (ascNum <= 1) return 'Subject';
    var isMale = (ascNum % 2 === 0);
    var n = ascNum;
    while (n > 3) { n = Math.floor(n / 2); }
    var side = (n === 2) ? 'Pat.' : 'Mat.';
    var gen = Math.floor(Math.log2(ascNum));
    if (gen === 1) return isMale ? 'Father' : 'Mother';
    if (gen === 2) return side + ' ' + (isMale ? 'Grandfather' : 'Grandmother');
    if (gen === 3) return side + ' Gr-' + (isMale ? 'Grandfather' : 'Grandmother');
    var greats = gen - 2;
    return side + ' ' + greats + 'x Gr-' + (isMale ? 'Grandfather' : 'Grandmother');
  }

  // Format name with SURNAME uppercase
  function formatName(name) {
    if (!name) return 'Unknown';
    var parts = name.split(' ');
    if (parts.length <= 1) return parts[0].toUpperCase();
    return parts.slice(0, -1).join(' ') + ' ' + parts[parts.length - 1].toUpperCase();
  }

  // Extract birth year
  function birthYear(dateStr) {
    if (!dateStr) return '';
    var m = dateStr.match(/\d{4}/);
    return m ? m[0] : '';
  }

  // Truncate place to first part only (for card)
  function shortPlace(place) {
    if (!place) return '';
    var parts = place.split(',').map(function(p) { return p.trim(); }).filter(Boolean);
    if (parts.length <= 2) return parts.join(', ');
    return parts[0] + ', ' + parts[1];
  }

  // Confidence label
  function confidenceLabel(a) {
    if (!a) return '';
    var score = a.confidence_score || 0;
    var level = a.confidence_level || 'Unknown';
    return level + ' ' + score + '%';
  }

  // Build and render the tree
  function render(container, jobId, generations, ancestors, options) {
    options = options || {};
    var ancestorMap = {};
    (ancestors || []).forEach(function (a) {
      ancestorMap[a.ascendancy_number] = a;
    });

    container.innerHTML = '';
    container.className = 'tree-cards-container';

    var maxGen = Math.min(generations, 6);

    // Create generation rows
    for (var gen = 0; gen <= maxGen; gen++) {
      var genRow = document.createElement('div');
      genRow.className = 'tree-gen-row';
      genRow.setAttribute('data-gen', gen);

      // Generation label
      var genLabel = document.createElement('div');
      genLabel.className = 'tree-gen-label';
      genLabel.textContent = 'Gen ' + gen + (gen === 0 ? ' (Subject)' : '');
      genRow.appendChild(genLabel);

      var cardsWrap = document.createElement('div');
      cardsWrap.className = 'tree-cards-wrap';

      var startAsc = Math.pow(2, gen);
      var endAsc = Math.pow(2, gen + 1) - 1;

      for (var asc = startAsc; asc <= endAsc; asc++) {
        var a = ancestorMap[asc] || null;
        var card = createCard(a, asc, jobId, options);
        cardsWrap.appendChild(card);
      }

      genRow.appendChild(cardsWrap);
      container.appendChild(genRow);
    }

    // Draw SVG connector lines
    requestAnimationFrame(function () {
      drawConnectors(container, maxGen);
    });
  }

  function createCard(ancestor, ascNum, jobId, options) {
    var isEmpty = !ancestor;
    var col = colorForAncestor(ancestor);
    var relation = getRelationToSubject(ascNum);

    var card = document.createElement('div');
    card.className = 'tree-card' + (isEmpty ? ' tree-card-empty' : '');
    card.setAttribute('data-asc', ascNum);
    card.style.borderColor = col.border;
    if (!isEmpty) {
      card.style.background = col.bg;
    }

    // Header: asc# + relationship
    var header = document.createElement('div');
    header.className = 'tree-card-header';
    header.innerHTML = '<span class="tree-card-asc">#' + ascNum + '</span> ' +
      '<span class="tree-card-relation">' + relation + '</span>';
    card.appendChild(header);

    if (isEmpty) {
      var emptyLabel = document.createElement('div');
      emptyLabel.className = 'tree-card-name tree-card-name-empty';
      emptyLabel.textContent = 'Not Found';
      card.appendChild(emptyLabel);
    } else {
      // Name
      var nameEl = document.createElement('div');
      nameEl.className = 'tree-card-name';
      nameEl.textContent = formatName(ancestor.name);
      card.appendChild(nameEl);

      // Birth
      var by = birthYear(ancestor.birth_date);
      var bp = shortPlace(ancestor.birth_place);
      if (by || bp) {
        var birthEl = document.createElement('div');
        birthEl.className = 'tree-card-detail';
        birthEl.textContent = 'b. ' + (by || '?') + (bp ? ', ' + bp : '');
        card.appendChild(birthEl);
      }

      // Death
      var dy = birthYear(ancestor.death_date);
      if (dy) {
        var deathEl = document.createElement('div');
        deathEl.className = 'tree-card-detail';
        deathEl.textContent = 'd. ' + dy;
        card.appendChild(deathEl);
      }

      // Confidence badge
      var badge = document.createElement('div');
      badge.className = 'tree-card-badge';
      badge.style.color = col.text;
      badge.textContent = confidenceLabel(ancestor);
      card.appendChild(badge);

      // Missing info warning
      var missingInfo = ancestor.missing_info || [];
      if (typeof missingInfo === 'string') {
        try { missingInfo = JSON.parse(missingInfo); } catch(e) { missingInfo = []; }
      }
      var hasMissing = Array.isArray(missingInfo) && missingInfo.length > 0;

      // Action buttons
      var actions = document.createElement('div');
      actions.className = 'tree-card-actions';

      // Accepted badge or Accept button
      var isAccepted = ancestor.accepted || ancestor.confidence_level === 'Customer Data';
      if (isAccepted) {
        var acceptedBadge = document.createElement('span');
        acceptedBadge.className = 'tree-card-accepted';
        acceptedBadge.innerHTML = '&#10003;';
        acceptedBadge.title = 'Accepted';
        actions.appendChild(acceptedBadge);
      } else if (ancestor.confidence_level !== 'Customer Data' && ascNum > 1) {
        var acceptBtn = document.createElement('button');
        acceptBtn.className = 'tree-card-btn tree-card-btn-accept';
        acceptBtn.textContent = 'Accept';
        acceptBtn.title = 'Accept this ancestor';
        acceptBtn.onclick = function (e) {
          e.stopPropagation();
          var form = document.createElement('form');
          form.method = 'POST';
          form.action = '/admin/research/' + jobId + '/ancestor/' + ancestor.id + '/accept';
          document.body.appendChild(form);
          form.submit();
        };
        actions.appendChild(acceptBtn);
      }

      // Details link
      var detailBtn = document.createElement('a');
      detailBtn.className = 'tree-card-btn tree-card-btn-detail';
      detailBtn.href = '/admin/research/' + jobId + '/ancestor/' + ancestor.id;
      detailBtn.textContent = 'Details';
      detailBtn.onclick = function(e) { e.stopPropagation(); };
      actions.appendChild(detailBtn);

      // Missing info icon
      if (hasMissing) {
        var warnIcon = document.createElement('span');
        warnIcon.className = 'tree-card-warn';
        warnIcon.innerHTML = '&#9888;';
        warnIcon.title = missingInfo.map(function(m) { return m.message || m; }).join('\n');
        actions.appendChild(warnIcon);
      }

      card.appendChild(actions);

      // Click card to go to detail
      card.style.cursor = 'pointer';
      card.onclick = function () {
        window.location.href = '/admin/research/' + jobId + '/ancestor/' + ancestor.id;
      };
    }

    return card;
  }

  // Draw SVG connector lines between parent and child cards
  function drawConnectors(container, maxGen) {
    // Remove existing SVG
    var existing = container.querySelector('.tree-connectors-svg');
    if (existing) existing.remove();

    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'tree-connectors-svg');
    svg.style.position = 'absolute';
    svg.style.top = '0';
    svg.style.left = '0';
    svg.style.width = '100%';
    svg.style.height = '100%';
    svg.style.pointerEvents = 'none';
    svg.style.zIndex = '0';

    var containerRect = container.getBoundingClientRect();
    svg.setAttribute('viewBox', '0 0 ' + container.scrollWidth + ' ' + container.scrollHeight);
    svg.setAttribute('width', container.scrollWidth);
    svg.setAttribute('height', container.scrollHeight);

    // For each non-subject ancestor, draw line from their card to their child's card
    for (var gen = 1; gen <= maxGen; gen++) {
      var startAsc = Math.pow(2, gen);
      var endAsc = Math.pow(2, gen + 1) - 1;

      for (var asc = startAsc; asc <= endAsc; asc++) {
        var childAsc = Math.floor(asc / 2);
        var parentCard = container.querySelector('[data-asc="' + asc + '"]');
        var childCard = container.querySelector('[data-asc="' + childAsc + '"]');

        if (parentCard && childCard) {
          var parentRect = parentCard.getBoundingClientRect();
          var childRect = childCard.getBoundingClientRect();

          // Parent top center → child bottom center
          var x1 = parentRect.left + parentRect.width / 2 - containerRect.left + container.scrollLeft;
          var y1 = parentRect.top - containerRect.top + container.scrollTop;
          var x2 = childRect.left + childRect.width / 2 - containerRect.left + container.scrollLeft;
          var y2 = childRect.top + childRect.height - containerRect.top + container.scrollTop;

          // Curved connector
          var midY = (y1 + y2) / 2;
          var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          path.setAttribute('d', 'M' + x2 + ' ' + y2 + ' C' + x2 + ' ' + midY + ' ' + x1 + ' ' + midY + ' ' + x1 + ' ' + y1);
          path.setAttribute('fill', 'none');
          path.setAttribute('stroke', '#c8c0b4');
          path.setAttribute('stroke-width', '1.5');
          path.setAttribute('stroke-dasharray', parentCard.classList.contains('tree-card-empty') ? '4 3' : 'none');
          svg.appendChild(path);
        }
      }
    }

    container.style.position = 'relative';
    container.insertBefore(svg, container.firstChild);
  }

  // Poll and re-render (with tree cards)
  function startPolling(container, jobId, generations, progressEl, counterEl) {
    var active = true;

    function poll() {
      if (!active) return;

      fetch('/admin/research/' + jobId + '/ancestors')
        .then(function (res) { return res.json(); })
        .then(function (data) {
          render(container, jobId, data.generations || generations, data.ancestors || []);

          // Update progress bar
          if (progressEl) {
            if (data.status === 'running') {
              var pct = data.progress_total > 0
                ? Math.round((data.progress_current / data.progress_total) * 100) : 0;
              progressEl.innerHTML =
                '<div style="background:#e8e8e8;border-radius:8px;height:20px;overflow:hidden;margin-bottom:6px;">' +
                '<div style="background:var(--sage);height:100%;width:' + pct + '%;transition:width 0.5s;border-radius:8px;display:flex;align-items:center;justify-content:center;">' +
                (pct > 15 ? '<span style="color:white;font-size:10px;font-weight:700;">' + pct + '%</span>' : '') +
                '</div></div>' +
                '<div style="font-size:13px;color:var(--forest);">' + (data.progress_message || 'Researching...') + '</div>';
            } else if (data.status === 'completed') {
              progressEl.innerHTML = '<div style="font-size:13px;color:var(--success);font-weight:600;">Research complete \u2014 <a href="javascript:location.reload()">Refresh</a></div>';
              active = false;
            } else if (data.status === 'failed') {
              progressEl.innerHTML = '<div style="font-size:13px;color:var(--danger);font-weight:600;">Research failed</div>';
              active = false;
            }
          }

          // Update counter
          if (counterEl && data.accepted_count !== undefined) {
            counterEl.textContent = data.accepted_count + '/' + data.total_slots;
          }

          if (data.status === 'running' || data.status === 'pending') {
            setTimeout(poll, 4000);
          } else {
            active = false;
          }
        })
        .catch(function () {
          setTimeout(poll, 6000);
        });
    }

    poll();
    return { stop: function () { active = false; } };
  }

  // Expose
  window.TreeCards = {
    render: render,
    startPolling: startPolling,
  };
})();
