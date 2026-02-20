// fan-chart.js — Interactive SVG pedigree fan chart
// Pure vanilla JS, no dependencies

(function () {
  'use strict';

  // Confidence → colour map
  var COLORS = {
    verified:      { fill: '#d4edda', stroke: '#27ae60', text: '#155724' },
    probable:      { fill: '#d6eaf8', stroke: '#2980b9', text: '#1a5276' },
    possible:      { fill: '#fff3cd', stroke: '#f39c12', text: '#856404' },
    customer_data: { fill: '#e8daef', stroke: '#8e44ad', text: '#6c3483' },
    rejected:      { fill: '#f8d7da', stroke: '#c0392b', text: '#721c24' },
    empty:         { fill: '#f0e8da', stroke: '#d5cec2', text: '#999' },
  };

  function colorForAncestor(a) {
    if (!a) return COLORS.empty;
    var s = a.confidence_score || 0;
    var lvl = (a.confidence_level || '').toLowerCase().replace(/\s+/g, '_');
    if (lvl === 'customer_data') return COLORS.customer_data;
    if (s >= 90) return COLORS.verified;
    if (s >= 75) return COLORS.probable;
    if (s >= 50) return COLORS.possible;
    if (s > 0 || a.fs_person_id) return COLORS.rejected;
    return COLORS.empty;
  }

  // Relationship labels for generations 0-2
  var LABELS = {
    1: 'Subject',
    2: 'Father', 3: 'Mother',
    4: 'Pat. Grandfather', 5: 'Pat. Grandmother',
    6: 'Mat. Grandfather', 7: 'Mat. Grandmother',
  };

  // Extract birth year from date string
  function birthYear(dateStr) {
    if (!dateStr) return '';
    var m = dateStr.match(/\d{4}/);
    return m ? m[0] : '';
  }

  // Truncate text to fit
  function truncate(str, max) {
    if (!str) return '';
    return str.length <= max ? str : str.substring(0, max - 1) + '\u2026';
  }

  // Polar → Cartesian
  function polarToXY(cx, cy, r, angleDeg) {
    var rad = (angleDeg - 90) * Math.PI / 180;
    return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
  }

  // Create an arc path (annular sector)
  function arcPath(cx, cy, rInner, rOuter, startDeg, endDeg) {
    var s1 = polarToXY(cx, cy, rOuter, startDeg);
    var e1 = polarToXY(cx, cy, rOuter, endDeg);
    var s2 = polarToXY(cx, cy, rInner, endDeg);
    var e2 = polarToXY(cx, cy, rInner, startDeg);
    var largeArc = (endDeg - startDeg) > 180 ? 1 : 0;

    return [
      'M', s1.x, s1.y,
      'A', rOuter, rOuter, 0, largeArc, 1, e1.x, e1.y,
      'L', s2.x, s2.y,
      'A', rInner, rInner, 0, largeArc, 0, e2.x, e2.y,
      'Z',
    ].join(' ');
  }

  // Build the full fan chart SVG
  function render(container, jobId, generations, ancestors) {
    var maxGen = Math.min(generations, 5); // cap at 5 generations for layout
    var ancestorMap = {};
    (ancestors || []).forEach(function (a) {
      ancestorMap[a.ascendancy_number] = a;
    });

    // Dimensions
    var size = 640;
    var cx = size / 2;
    var cy = size / 2;
    var centerR = 50;
    var ringWidth = (size / 2 - centerR - 10) / maxGen;

    // Create SVG
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 ' + size + ' ' + size);
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', '100%');
    svg.style.maxWidth = size + 'px';

    // Background
    var bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    bg.setAttribute('width', size);
    bg.setAttribute('height', size);
    bg.setAttribute('fill', 'white');
    bg.setAttribute('rx', '12');
    svg.appendChild(bg);

    // Center circle — Subject (asc#1)
    var subject = ancestorMap[1];
    var subCol = colorForAncestor(subject);

    var circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', cx);
    circle.setAttribute('cy', cy);
    circle.setAttribute('r', centerR);
    circle.setAttribute('fill', subCol.fill);
    circle.setAttribute('stroke', subCol.stroke);
    circle.setAttribute('stroke-width', '2');
    circle.setAttribute('class', subject ? 'fan-arc' : 'fan-arc fan-arc-empty');
    if (subject && subject.id) {
      circle.setAttribute('data-ancestor-id', subject.id);
      circle.addEventListener('click', function () {
        window.location.href = '/admin/research/' + jobId + '/ancestor/' + subject.id;
      });
    }
    svg.appendChild(circle);

    // Subject text
    var subName = subject ? truncate(subject.name, 18) : 'Subject';
    var subYear = subject ? birthYear(subject.birth_date) : '';
    addCenterText(svg, cx, cy, subName, subYear, subCol.text);

    // Rings for generations 1..maxGen
    for (var gen = 1; gen <= maxGen; gen++) {
      var rInner = centerR + (gen - 1) * ringWidth;
      var rOuter = centerR + gen * ringWidth;
      var count = Math.pow(2, gen); // number of positions in this generation
      var startAsc = Math.pow(2, gen);  // first asc number
      var arcAngle = 360 / count;

      for (var i = 0; i < count; i++) {
        var ascNum = startAsc + i;
        var a = ancestorMap[ascNum] || null;
        var col = colorForAncestor(a);

        var startDeg = i * arcAngle;
        var endDeg = startDeg + arcAngle - 0.5; // small gap between arcs

        var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', arcPath(cx, cy, rInner, rOuter, startDeg, endDeg));
        path.setAttribute('fill', col.fill);
        path.setAttribute('stroke', col.stroke);
        path.setAttribute('stroke-width', '1.5');
        path.setAttribute('class', a ? 'fan-arc' : 'fan-arc fan-arc-empty');

        if (a && a.id) {
          (function (anc) {
            path.setAttribute('data-ancestor-id', anc.id);
            path.addEventListener('click', function () {
              window.location.href = '/admin/research/' + jobId + '/ancestor/' + anc.id;
            });
          })(a);
        }

        svg.appendChild(path);

        // Add text inside arc
        var midAngle = startDeg + arcAngle / 2;
        var textR = (rInner + rOuter) / 2;
        var maxChars = Math.max(4, Math.floor(arcAngle / (gen <= 2 ? 5 : gen <= 3 ? 7 : 10)));

        if (a) {
          var displayName = truncate(a.name, maxChars);
          var year = birthYear(a.birth_date);
          addArcText(svg, cx, cy, textR, midAngle, displayName, year, col.text, gen);
        } else {
          // Show relationship label for gen 1-2, or just the asc number
          var label = LABELS[ascNum] || '#' + ascNum;
          if (gen > 2) label = '#' + ascNum;
          addArcText(svg, cx, cy, textR, midAngle, truncate(label, maxChars), '', col.text, gen);
        }
      }
    }

    // Clear and insert
    container.innerHTML = '';
    container.appendChild(svg);
  }

  function addCenterText(svg, cx, cy, name, year, color) {
    var t1 = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    t1.setAttribute('x', cx);
    t1.setAttribute('y', cy - 6);
    t1.setAttribute('text-anchor', 'middle');
    t1.setAttribute('fill', color);
    t1.setAttribute('font-size', '11');
    t1.setAttribute('font-weight', '700');
    t1.setAttribute('class', 'fan-text');
    t1.textContent = name;
    svg.appendChild(t1);

    if (year) {
      var t2 = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      t2.setAttribute('x', cx);
      t2.setAttribute('y', cy + 10);
      t2.setAttribute('text-anchor', 'middle');
      t2.setAttribute('fill', color);
      t2.setAttribute('font-size', '10');
      t2.setAttribute('class', 'fan-text');
      t2.textContent = 'b. ' + year;
      svg.appendChild(t2);
    }
  }

  function addArcText(svg, cx, cy, r, angleDeg, name, year, color, gen) {
    var pos = polarToXY(cx, cy, r, angleDeg);
    var fontSize = gen <= 2 ? 10 : gen <= 3 ? 9 : 7;

    // Rotate text to follow the angle
    var rotation = angleDeg;
    // Flip text that would be upside down
    if (angleDeg > 90 && angleDeg < 270) {
      rotation = angleDeg + 180;
    }

    var g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('transform', 'translate(' + pos.x + ',' + pos.y + ') rotate(' + rotation + ')');
    g.setAttribute('class', 'fan-text');

    var t1 = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    t1.setAttribute('text-anchor', 'middle');
    t1.setAttribute('y', year ? -2 : 2);
    t1.setAttribute('fill', color);
    t1.setAttribute('font-size', fontSize);
    t1.setAttribute('font-weight', '600');
    t1.textContent = name;
    g.appendChild(t1);

    if (year && gen <= 3) {
      var t2 = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      t2.setAttribute('text-anchor', 'middle');
      t2.setAttribute('y', fontSize + 1);
      t2.setAttribute('fill', color);
      t2.setAttribute('font-size', Math.max(fontSize - 2, 6));
      t2.textContent = 'b. ' + year;
      g.appendChild(t2);
    }

    svg.appendChild(g);
  }

  // Poll for updates and re-render
  function startPolling(container, jobId, generations, progressEl) {
    var active = true;

    function poll() {
      if (!active) return;

      fetch('/admin/research/' + jobId + '/ancestors')
        .then(function (res) { return res.json(); })
        .then(function (data) {
          render(container, jobId, data.generations || generations, data.ancestors || []);

          // Update progress
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
              progressEl.innerHTML = '<div style="font-size:13px;color:var(--success);font-weight:600;">Research complete</div>';
              active = false;
            } else if (data.status === 'failed') {
              progressEl.innerHTML = '<div style="font-size:13px;color:var(--danger);font-weight:600;">Research failed</div>';
              active = false;
            } else {
              progressEl.innerHTML = '';
            }
          }

          if (data.status === 'running' || data.status === 'pending') {
            setTimeout(poll, 4000);
          } else {
            active = false;
          }
        })
        .catch(function () {
          // Retry on network error
          setTimeout(poll, 6000);
        });
    }

    poll();

    return { stop: function () { active = false; } };
  }

  // Expose
  window.FanChart = {
    render: render,
    startPolling: startPolling,
  };
})();
