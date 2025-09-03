export function openFormModal(opts = {}) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const content = document.createElement('div');
    content.className = 'modal-content';

    const form = document.createElement('form');
    form.style.display = 'flex';
    form.style.flexDirection = 'column';
    form.style.gap = '10px';

    if (opts.title) {
      const h3 = document.createElement('h3');
      h3.textContent = opts.title;
      form.appendChild(h3);
    }

    const fieldStates = [];
    (opts.fields || []).forEach(f => {
      const wrapper = document.createElement('div');
      wrapper.style.display = 'flex';
      wrapper.style.flexDirection = 'column';
      const label = document.createElement('label');
      label.textContent = f.label || f.name || '';
      label.style.marginBottom = '4px';
      let input;
      if (f.type === 'select') {
        input = document.createElement('select');
        (f.options || []).forEach(opt => {
          const option = document.createElement('option');
          if (typeof opt === 'object') {
            option.value = opt.value;
            option.textContent = opt.label;
          } else {
            option.value = option.textContent = opt;
          }
          input.appendChild(option);
        });
        if (f.value != null) input.value = f.value;
      } else {
        input = document.createElement('input');
        input.type = f.type || 'text';
        if (f.value != null) input.value = f.value;
        if (f.min != null) input.min = f.min;
        if (f.max != null) input.max = f.max;
        if (f.step != null) input.step = f.step;
      }
      input.style.width = '100%';
      if (f.placeholder) input.placeholder = f.placeholder;
      wrapper.appendChild(label);
      wrapper.appendChild(input);
      const err = document.createElement('div');
      err.style.color = 'red';
      err.style.fontSize = '0.9em';
      err.style.display = 'none';
      wrapper.appendChild(err);
      form.appendChild(wrapper);
      fieldStates.push({ field: f, input, err, wrapper });
    });

    const btnRow = document.createElement('div');
    btnRow.style.display = 'flex';
    btnRow.style.gap = '8px';
    btnRow.style.justifyContent = 'flex-end';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.textContent = 'Cancel';
    const saveBtn = document.createElement('button');
    saveBtn.type = 'submit';
    saveBtn.textContent = 'Save';
    saveBtn.style.background = '#0b5';
    saveBtn.style.color = '#fff';
    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(saveBtn);
    form.appendChild(btnRow);

    content.appendChild(form);
    overlay.appendChild(content);
    document.body.appendChild(overlay);

    const close = res => {
      document.body.removeChild(overlay);
      resolve(res);
    };

    cancelBtn.onclick = () => close(null);
    overlay.addEventListener('click', e => { if (e.target === overlay) close(null); });

    function currentValues() {
      const vals = {};
      fieldStates.forEach(s => {
        if (s.wrapper.style.display === 'none') return;
        vals[s.field.name] = s.input.value;
      });
      return vals;
    }

    function updateVisibility() {
      const vals = currentValues();
      fieldStates.forEach(s => {
        const show = typeof s.field.showIf === 'function' ? !!s.field.showIf(vals) : true;
        s.wrapper.style.display = show ? 'flex' : 'none';
      });
    }
    fieldStates.forEach(s => {
      s.input.addEventListener('input', updateVisibility);
      s.input.addEventListener('change', updateVisibility);
    });
    updateVisibility();

    form.addEventListener('submit', e => {
      e.preventDefault();
      const vals = currentValues();
      let ok = true;
      fieldStates.forEach(s => {
        if (s.wrapper.style.display === 'none') { s.err.style.display = 'none'; return; }
        const v = s.input.value;
        if (s.field.required && !v) {
          s.err.textContent = s.field.requiredMessage || 'This field is required';
          s.err.style.display = 'block';
          ok = false;
          return;
        }
        if (typeof s.field.validator === 'function') {
          const res = s.field.validator(v, vals);
          if (res !== true && res !== undefined && res !== null && res !== '') {
            s.err.textContent = typeof res === 'string' ? res : 'Invalid value';
            s.err.style.display = 'block';
            ok = false;
            return;
          }
        }
        s.err.style.display = 'none';
      });
      if (!ok) return;
      close(vals);
    });
  });
}

if (typeof window !== 'undefined') {
  window.openFormModal = openFormModal;
}

