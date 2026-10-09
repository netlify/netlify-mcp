(function () {
  var radar = document.getElementById('radar');
  var list = document.getElementById('contacts');
  var status = document.getElementById('status');
  var toggle = document.getElementById('toggle');
  var paused = false;
  var count = 0;

  function addContact() {
    var angle = Math.random() * 2 * Math.PI;
    var dist = 0.1 + Math.random() * 0.85;
    var x = 50 + Math.cos(angle) * dist * 50;
    var y = 50 + Math.sin(angle) * dist * 50;

    var blip = document.createElement('div');
    blip.className = 'blip';
    blip.style.left = x + '%';
    blip.style.top = y + '%';
    radar.appendChild(blip);
    setTimeout(function () { blip.remove(); }, 4000);

    count += 1;
    var li = document.createElement('li');
    li.textContent = '#' + count + ' bearing ' + Math.round(angle * 180 / Math.PI) +
      '° range ' + Math.round(dist * 100) + '%';
    list.insertBefore(li, list.firstChild);
    while (list.children.length > 20) { list.removeChild(list.lastChild); }
  }

  setInterval(function () { if (!paused) { addContact(); } }, 1500);

  toggle.addEventListener('click', function () {
    paused = !paused;
    radar.classList.toggle('paused', paused);
    status.textContent = paused ? 'PAUSED' : 'SCANNING…';
    toggle.textContent = paused ? 'Resume scan' : 'Pause scan';
  });
})();
