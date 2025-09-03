(function(){
  const containerId = 'notification-container';
  function ensureContainer(){
    let c = document.getElementById(containerId);
    if(!c){
      c = document.createElement('div');
      c.id = containerId;
      document.body.appendChild(c);
    }
    return c;
  }
  function notify(msg, type='success', timeout=3000){
    const container = ensureContainer();
    const div = document.createElement('div');
    div.className = `notification notification-${type}`;
    div.textContent = msg;
    container.appendChild(div);
    setTimeout(()=>{
      div.style.opacity = '0';
      setTimeout(()=> div.remove(), 500);
    }, timeout);
  }
  window.notifySuccess = msg => notify(msg, 'success');
  window.notifyError = msg => notify(msg, 'error');
})();
