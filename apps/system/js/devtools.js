/* global Service */
'use strict';

var DevtoolsDialog = {


  init: function md_init() {
    // Bind events
    window.addEventListener('devtools-toggle', this);
    this.active = false;
    this.windows = document.getElementById('windows');
    this.devtools = document.getElementById('devtools');
  },

  // Default event handler
  handleEvent: function md_handleEvent(evt) {
    switch (evt.type) {
      case 'devtools-toggle':
        if (!this.active) {
          this.windows.className = 'devtools-on';
          this.devtools.style.display = 'inline';
          this.active = true;
        } else {
          this.windows.className = '';
          this.devtools.style.display = 'none';
          this.active = false;
        }
        break;
    }
  }
};

DevtoolsDialog.init();
