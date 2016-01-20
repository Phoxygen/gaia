'use strict';

/* global Service, SettingsListener, BrowserKeyEventManager, LazyLoader */

(function(exports) {

  // Tell JSHint the following script are allow to use these variables.
  // The actual functions will be defined too.
  var HardwareButtonsBaseState;
  var HardwareButtonsHomeState;
  var HardwareButtonsCameraState;
  var HardwareButtonsSleepState;
  var HardwareButtonsVolumeState;
  var HardwareButtonsWakeState;
  var HardwareButtonsScreenshotState;
  var HardwareButtonsSystemLogState;

  /**
   * After bug 989198 landing, we will be able to listen to KeyboardEvent
   * (e.g. keydown and keyup). Also there will be new events called
   * BeforeAfterKeybaordEvent for mozbrowser-embedder iframe, say system app,
   * to control or override the bahavior of keydown/keyup event in
   * mozbrowser-embedded iframes (other apps or homescreen app).
   * These events are:
   *
   * * mozbrowserbeforekeydown
   * * mozbrowserafterkeydown
   * * mozbrowserbeforekeyup
   * * mozbrowserafterkeyup
   *
   * When a key is pressed down, the event sequence would be:
   * 1. `mozbrowserbeforekeydown` is dispatched to mozbrowser-embedder iframe
   * 2. `keydown` is dispatched to mozbrowser-embedded iframe
   * 3. `mozbrowserkeydown` is dispatched to mozbrowser-embedder iframe
   *
   * For detail, please see
   * https://wiki.mozilla.org/WebAPI/BrowserAPI/KeyboardEvent
   *
   * This module listens for KeyboardEvent and BeforeAfterKeybaordEvent,
   * processes them (with the help of BrowserKeyEventManager submodule)
   * and generates higher-level events to handle autorepeat on
   * the volume keys, long presses on Home and Sleep, and the Volume Down+Sleep
   * key combination.
   *
   * Other system app modules should listen for the high-level button events
   * generated by this module.
   *
   * The high-level events generated by this module are simple Event objects
   * that are not cancelable and do not bubble.  They are dispatched at the
   * window object.  The type property is set to one of these:
   *
   * | Event Type   |  Meaning                                                 |
   * |--------------|----------------------------------------------------------|
   * | home         | short press and release of home button                   |
   * | holdhome     | long press and hold of home button                       |
   * | sleep        | short press and release of sleep button                  |
   * | wake         | sleep or home pressed while sleeping                     |
   * | holdsleep    | long press and hold of sleep button                      |
   * | volumeup     | volume up pressed and released or autorepeated           |
   * | volumedown   | volume down pressed and released or autorepeated         |
   * | volumedown   | volume down and sleep pressed at same time (used for     |
   * |   + sleep    | screenshots)                                             |
   * | volumedown   | volume up and sleep pressed at same time (used for       |
   * |   + volumeup | systemlog capture)                                       |
   * | camera       | short press and release of camera button                 |
   * | holdcamera   | long press and hold of camera button                     |
   *
   * Because these events are fired at the window object, they cannot be
   * captured.  Many modules listen for the home event. Those that want
   * to respond to it and prevent others from responding should call
   * `stopImmediatePropagation()`. Overlays that want to prevent the window
   * manager from showing the homescreen on the home event should call that
   * method.  Note, however, that this only works for scripts that run and
   * register their event handlers before `AppWindowManager` does.
   *
   * As of the implementation itself, we process events with a
   * finite state machine.
   * Each state object has a `process()` method for handling events.
   * And optionally has `enter()` and `exit()` methods called when the FSM
   * enters and exits that state.
   *
   * @example
   * var hardwareButtons = new HardwareButtons();
   * hardwareButtons.start(); // Attach the event listeners.
   * hardwareButtons.stop();  // Deattach the event listeners.
   *
   * @class    HardwareButtons
   * @requires Service
   * @requires BrowserKeyEventManager
   **/
  var HardwareButtons = function HardwareButtons() {
    this._started = false;
    this._softwareHome = false;
  };

  /**
   * A mapping between state keyboard and the constructor.
   * @type {Object}
   */
  HardwareButtons.STATES = {};

  /**
   * How long for press and hold Home or Sleep.
   * @memberof HardwareButtons.prototype
   * @type {Number}
   */
  HardwareButtons.prototype.HOLD_INTERVAL = 750;

  /**
   * How long before volume autorepeat begins.
   * @memberof HardwareButtons.prototype
   * @type {Number}
   */
  HardwareButtons.prototype.REPEAT_DELAY = 700;

  /**
   * How fast the autorepeat is.
   * @memberof HardwareButtons.prototype
   * @type {Number}
   */
  HardwareButtons.prototype.REPEAT_INTERVAL = 100;

  /**
   * Start listening to events from Gecko and FSM.
   * @memberof HardwareButtons.prototype
   */
  HardwareButtons.prototype.start = function hb_start() {
    if (this._started) {
      throw 'Instance should not be start()\'ed twice.';
    }
    this._started = true;

    // Kick off the FSM in the base state
    this.state = new HardwareButtonsBaseState(this);

    window.addEventListener('softwareButtonEvent', this);

    // These event handler listens for hardware button events and passes the
    // event type to the process() method of the current state for processing
    window.addEventListener('mozbrowserbeforekeydown', this);
    window.addEventListener('mozbrowserbeforekeyup', this);
    window.addEventListener('mozbrowserafterkeydown', this);
    window.addEventListener('mozbrowserafterkeyup', this);
    window.addEventListener('keydown', this);
    window.addEventListener('keyup', this);

    SettingsListener.observe('software-button.enabled', false, function(value) {
      this._softwareHome = value;
    }.bind(this));


    return LazyLoader.load(['js/browser_key_event_manager.js']).then(() => {
      // initiate BrowserKeyEventManager submodule
      this.browserKeyEventManager = new BrowserKeyEventManager();
    });
  };

  /**
   * Stop listening to events. Must call before throwing away the instance
   * to avoid memory leaks.
   * @memberof HardwareButtons.prototype
   */
  HardwareButtons.prototype.stop = function hb_stop() {
    if (!this._started) {
      throw 'Instance was never start()\'ed but stop() is called.';
    }
    this._started = false;

    // Exit the current state()
    if (this.state && this.state.exit) {
      this.state.exit();
    }

    this.state = null;

    window.removeEventListener('softwareButtonEvent', this);

    window.removeEventListener('mozbrowserbeforekeydown', this);
    window.removeEventListener('mozbrowserbeforekeyup', this);
    window.removeEventListener('mozbrowserafterkeydown', this);
    window.removeEventListener('mozbrowserafterkeyup', this);
    window.removeEventListener('keydown', this);
    window.removeEventListener('keyup', this);
  };

  /**
   * Dispatch a high-level event of the specified type.
   * @memberof HardwareButtons.prototype
   * @param  {String} type name of the event.
   */
  HardwareButtons.prototype.publish = function hb_publish(type) {
    window.dispatchEvent(new CustomEvent(type, { bubbles: type === 'home' }));
  };

  /**
   * Transit the FSM to a new state.
   * @memberof HardwareButtons.prototype
   * @param {String} s    Keyword of the new state to switch to.
   * @param {String} type Name of the event to handle
   */
  HardwareButtons.prototype.setState = function hb_setState(s, type) {
    // Exit the current state()
    if (this.state && this.state.exit) {
      this.state.exit(type);
    }

    this.state = new HardwareButtons.STATES[s](this);

    // Enter the new this.state
    if (this.state && this.state.enter) {
      this.state.enter(type);
    }
  };

  /**
   * Handle events from Gecko.
   * @memberof HardwareButtons.prototype
   * @param  {Object} evt Event.
   */
  HardwareButtons.prototype.handleEvent = function hb_handleEvent(evt) {
    // When the software home button is displayed we ignore the hardware
    // home button if there is one
    var hardwareHomeEvent =
      (this.browserKeyEventManager.isHardwareKeyEvent(evt.type)) &&
      this.browserKeyEventManager.isHomeKey(evt);
    if (this._softwareHome && hardwareHomeEvent) {
      // Given that software home button is enabled, when we receive
      // mozbrowserbeforekeydown/mozbrowserbeforekeyup event of home button in
      // system app, Gecko will dispatch keydown/keyup events to embedded frame
      // (i.e. Homescreen app or web pages in browser). Even though these apps
      // or web pages do not listen to 'Home' key events, there are still
      // default action. The default action usually is to scroll to top of the
      // page. That's why we need to call preventDefault() here.
      // See https://bugzil.la/1105285#c12 for detail.
      evt.preventDefault();
      return;
    }

    if (evt.type === 'softwareButtonEvent') {
      var type = evt.detail.type;
      switch (type) {
        case 'home-button-press':
        case 'home-button-release':
        case 'holdhome-button-press':
        case 'holdhome-button-release':
        case 'sleep-button-press':
        case 'sleep-button-release':
        case 'volume-up-button-press':
        case 'volume-up-button-release':
        case 'volume-down-button-press':
        case 'volume-down-button-release':
          this.state.process(type);
          break;
      }
    } else {
      // Figure out if we should process this key event here in the
      // system app. The browserKeyEventManager returns an event name
      // (like 'volume-down-button-press') if we should process it and
      // returns undefined otherwise. Note that the value returned
      // may depend on whether or not there is already a button pressed.
      var isButtonPressed = !(this.state instanceof HardwareButtonsBaseState);
      var buttonEventType =
        this.browserKeyEventManager.getButtonEventType(evt, isButtonPressed);
      if (buttonEventType) {
        this.state.process(buttonEventType);
      }
    }
  };

  /**
   * The base state is the default, when no hardware buttons are pressed.
   *
   * @class HardwareButtonsBaseState
   */
  HardwareButtonsBaseState =
    HardwareButtons.STATES.base = function HardwareButtonsBaseState(hb) {
      this.hardwareButtons = hb;
    };

  /**
   * Process the event, maybe transition the state.
   * @memberof HardwareButtonsBaseState.prototype
   * @param  {String} type Name of the event to process.
   */
  HardwareButtonsBaseState.prototype.process = function(type) {
    switch (type) {
      case 'home-button-press':
        /**
         * If the phone is sleeping, then pressing Home wakes it
         * (on press, not release)
         * @event HardwareButtonsBaseState#wake
         */
        // XXX: Unresolved dependency to screenManager
        if (!Service.query('screenEnabled')) {
          this.hardwareButtons.publish('wake');
          this.hardwareButtons.setState('wake', type);
        } else {
          this.hardwareButtons.setState('home', type);
        }
        return;
      case 'holdhome-button-release':
        this.hardwareButtons.publish('holdhome');
        this.hardwareButtons.setState('base');
        return;
      case 'sleep-button-press':
        /**
         * If the phone is sleeping, then pressing Home wakes it
         * (on press, not release)
         * @event HardwareButtonsBaseState#wake
         */
        // XXX: Unresolved dependency to screenManager
        if (!Service.query('screenEnabled')) {
          this.hardwareButtons.publish('wake');
          this.hardwareButtons.setState('wake', type);
        } else {
          this.hardwareButtons.setState('sleep', type);
        }
        return;
      case 'volume-up-button-press':
      case 'volume-down-button-press':
        this.hardwareButtons.setState('volume', type);
        return;
      case 'camera-button-press':
        this.hardwareButtons.setState('camera', type);
        return;
      case 'home-button-release':
      case 'sleep-button-release':
      case 'volume-up-button-release':
      case 'volume-down-button-release':
      case 'camera-button-release':
      case 'holdhome-button-press':
      case 'devtools-button-press':
        // Ignore button releases that occur in this state.
        // These can happen after volumedown+sleep and home+volume.
        return;
      case 'devtools-button-release':
        this.hardwareButtons.publish('devtools-toggle');
        break;
    }
    console.error('Unexpected hardware key: ', type);
  };

  /**
   * We enter the home state when the user presses the Home button
   * We can fire home or holdhome events from this state
   *
   * @class HardwareButtonsHomeState
   */
  HardwareButtonsHomeState =
    HardwareButtons.STATES.home = function HardwareButtonsHomeState(hb) {
      this.hardwareButtons = hb;
      this.timer = undefined;
    };

  /**
   * Entering the state.
   * @memberof HardwareButtonsHomeState.prototype
   */
  HardwareButtonsHomeState.prototype.enter = function() {
    this.timer = setTimeout(function() {
      /**
       * When the user holds Home button more than HOLD_INTERVAL.
       * @event HardwareButtonsHomeState#holdhome
       */
      this.hardwareButtons.publish('holdhome');
      navigator.vibrate(50);
      this.hardwareButtons.setState('base');
    }.bind(this), this.hardwareButtons.HOLD_INTERVAL);
  };

  /**
   * Leaving the state.
   * @memberof HardwareButtonsHomeState.prototype
   */
  HardwareButtonsHomeState.prototype.exit = function() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  };

  /**
   * Process the event, maybe transition the state.
   * @memberof HardwareButtonsHomeState.prototype
   * @param  {String} type Name of the event to process.
   */
  HardwareButtonsHomeState.prototype.process = function(type) {
    switch (type) {
      case 'home-button-release':
        /**
         * When the user releases Home button before HOLD_INTERVAL.
         * @event HardwareButtonsHomeState#home
         */
        this.hardwareButtons.publish('home');
        navigator.vibrate(50);
        this.hardwareButtons.setState('base', type);
        return;
      case 'volume-up-button-press':
      case 'volume-down-button-press':
      case 'sleep-button-press':
        this.hardwareButtons.setState('base', type);
        return;
    }
    console.error('Unexpected hardware key: ', type);
    this.hardwareButtons.setState('base', type);
  };

  /**
   * We enter the sleep state when the user presses the Sleep button
   * We can fire sleep, or holdsleep events from this state.
   *
   * @class  HardwareButtonsSleepState
   */
  HardwareButtonsSleepState =
    HardwareButtons.STATES.sleep = function HardwareButtonsSleepState(hb) {
      this.hardwareButtons = hb;
      this.timer = undefined;
    };

  /**
   * Entering the state.
   * @memberof HardwareButtonsSleepState.prototype
   */
  HardwareButtonsSleepState.prototype.enter = function() {
    this.timer = setTimeout(function() {
      /**
       * When the user holds Sleep button more than HOLD_INTERVAL.
       * @event HardwareButtonsSleepState#holdsleep
       */
      this.hardwareButtons.publish('holdsleep');
      this.hardwareButtons.setState('base');
    }.bind(this), this.hardwareButtons.HOLD_INTERVAL);
  };

  /**
   * Leaving the state.
   * @memberof HardwareButtonsSleepState.prototype
   */
  HardwareButtonsSleepState.prototype.exit = function() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  };

  /**
   * Process the event, maybe transition the state.
   * @memberof HardwareButtonsSleepState.prototype
   * @param  {String} type Name of the event to process.
   */
  HardwareButtonsSleepState.prototype.process = function(type) {
    switch (type) {
      case 'sleep-button-release':
        /**
         * When the user releases Sleep button before HOLD_INTERVAL.
         * @event HardwareButtonsSleepState#sleep
         */
        this.hardwareButtons.publish('sleep');
        this.hardwareButtons.setState('base', type);
        return;
      case 'volume-down-button-press':
        /**
         * When the user presses Volume Down button, before HOLD_INTERVAL,
         * while holding the Sleep button.
         */
        this.hardwareButtons.setState('screenshot', type);
        return;
      case 'home-button-press':
        this.hardwareButtons.setState('base', type);
        return;
    }
    console.error('Unexpected hardware key: ', type);
    this.hardwareButtons.setState('base', type);
  };

  /**
   * We enter the volume state when the user presses the volume up or
   * volume down buttons.
   * We can fire volumeup and volumedown events from this state
   *
   * @class  HardwareButtonsVolumeState
   *
   */
  HardwareButtonsVolumeState =
    HardwareButtons.STATES.volume = function HardwareButtonsVolumeState(hb) {
      this.hardwareButtons = hb;
      this.timer = undefined;
      this.repeating = false;
    };

  /**
   * Trigger repeat actions for volume buttons.
   * @memberof HardwareButtonsVolumeState.prototype
   */
  HardwareButtonsVolumeState.prototype.repeat = function() {
    this.repeating = true;
    if (this.direction === 'volume-up-button-press') {
      /**
       * Volume up pressed and released or autorepeated.
       * @event HardwareButtonsVolumeState#volumeup
       */
      this.hardwareButtons.publish('volumeup');
    } else {
      /**
       * Volume down pressed and released or autorepeated.
       * @event HardwareButtonsVolumeState#volumedown
       */
      this.hardwareButtons.publish('volumedown');
    }
    this.timer = setTimeout(this.repeat.bind(this),
      this.hardwareButtons.REPEAT_INTERVAL);
  };

  /**
   * Entering the state.
   * @memberof HardwareButtonsVolumeState.prototype
   * @param  {String} type Name of the event to process.
   */
  HardwareButtonsVolumeState.prototype.enter = function(type) {
    this.direction = type;  // Is volume going up or down?
    this.repeating = false;
    this.timer =
      setTimeout(this.repeat.bind(this), this.hardwareButtons.REPEAT_DELAY);
  };

  /**
   * Leaving the state.
   * @memberof HardwareButtonsVolumeState.prototype
   */
  HardwareButtonsVolumeState.prototype.exit = function() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  };

  /**
   * Process the event, maybe transition the state.
   * @memberof HardwareButtonsVolumeState.prototype
   * @param  {String} type Name of the event to process.
   */
  HardwareButtonsVolumeState.prototype.process = function(type) {
    switch (type) {
      case 'home-button-press':
        this.hardwareButtons.setState('base', type);
        return;
      case 'sleep-button-press':
        if (this.direction === 'volume-down-button-press') {
          /**
           * When the user presses Sleep button, before HOLD_INTERVAL,
           * while holding the Volume Down button.
           */
          this.hardwareButtons.setState('screenshot', type);
          return;
        }
        this.hardwareButtons.setState('sleep', type);
        return;
      case 'volume-down-button-press':
      case 'volume-up-button-press':
        this.hardwareButtons.setState('systemlog', type);
        return;
      case 'volume-up-button-release':
        if (this.direction === 'volume-up-button-press') {
          if (!this.repeating) {
            this.hardwareButtons.publish('volumeup');
          }
          this.hardwareButtons.setState('base', type);
          return;
        }
        break;
      case 'volume-down-button-release':
        if (this.direction === 'volume-down-button-press') {
          if (!this.repeating) {
            this.hardwareButtons.publish('volumedown');
          }
          this.hardwareButtons.setState('base', type);
          return;
        }
        break;
      default:
        // Ignore anything else (such as sleep button release)
        return;
    }
    console.error('Unexpected hardware key: ', type);
    this.hardwareButtons.setState('base', type);
  };

  /**
   * We enter this state when the user presses Home or Sleep on a sleeping
   * phone.  We give immediate feedback by waking the phone up on the press
   * rather than waiting for the release, but this means we need a special
   * state so that we don't actually send a home or sleep event on the
   * key release.  Note, however, that this state does set a timer so that
   * it can send holdhome or holdsleep events.  (This means that pressing and
   * holding sleep will bring up the power menu, even on a sleeping phone.)
   *
   * @class  HardwareButtonsWakeState
   */
  HardwareButtonsWakeState =
    HardwareButtons.STATES.wake = function HardwareButtonsWakeState(hb) {
      this.hardwareButtons = hb;
      this.timer = undefined;
      this.delegateState = null;
    };

  /**
   * Entering the state.
   * @memberof HardwareButtonsWakeState.prototype
   */
  HardwareButtonsWakeState.prototype.enter = function(type) {
    if (type === 'home-button-press') {
      this.delegateState = new HardwareButtonsHomeState(this.hardwareButtons);
    } else {
      this.delegateState = new HardwareButtonsSleepState(this.hardwareButtons);
    }

    this.timer = setTimeout(function() {
      if (type === 'home-button-press') {
        /**
         * When the user holds Home button more than HOLD_INTERVAL.
         * @event HardwareButtonsWakeState#holdhome
         */
        this.hardwareButtons.publish('holdhome');
      } else if (type === 'sleep-button-press') {
        /**
         * When the user holds Sleep button more than HOLD_INTERVAL.
         * @event HardwareButtonsWakeState#holdsleep
         */
        this.hardwareButtons.publish('holdsleep');
      }
      this.hardwareButtons.setState('base', type);
    }.bind(this), this.hardwareButtons.HOLD_INTERVAL);
  };

  /**
   * Leaving the state.
   * @memberof HardwareButtonsWakeState.prototype
   */
  HardwareButtonsWakeState.prototype.exit = function() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  };

  /**
   * Process the event, maybe transition the state.
   * @memberof HardwareButtonsWakeState.prototype
   * @param  {String} type Name of the event to process.
   */
  HardwareButtonsWakeState.prototype.process = function(type) {
    switch (type) {
      case 'home-button-release':
      case 'sleep-button-release':
        this.hardwareButtons.setState('base', type);
        return;
      default:
        this.delegateState.process(type);
        return;
    }
  };

  /**
   * We enter the screenshot home state when the user presses the Power button
   * and Volume Down button within less than HOLD_INTERVAL of each other
   * We can fire home or holdhome events from this state
   *
   * @class HardwareButtonsScreenshotState
   */
  HardwareButtonsScreenshotState =
    HardwareButtons.STATES.screenshot =
    function HardwareButtonsScreenshotState(hb) {
      this.hardwareButtons = hb;
      this.timer = undefined;
    };

  /**
   * Entering the state.
   * @memberof HardwareButtonsScreenshotState.prototype
   */
  HardwareButtonsScreenshotState.prototype.enter = function() {
    this.timer = setTimeout(function() {
      /**
       * When the user holds Volume Down and Power button
       * more than HOLD_INTERVAL.
       * @event HardwareButtonsHomeState#volumedown+sleep
       */
      this.hardwareButtons.publish('volumedown+sleep');
      this.hardwareButtons.setState('base');
    }.bind(this), this.hardwareButtons.HOLD_INTERVAL);
  };

  /**
   * Leaving the state.
   * @memberof HardwareButtonsScreenshotState.prototype
   */
  HardwareButtonsScreenshotState.prototype.exit = function() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  };

  /**
   * Pressing any other hardware button will cancel this state.
   * @memberof HardwareButtonsScreenshotState.prototype
   * @param  {String} type Name of the event to process.
   */
  HardwareButtonsScreenshotState.prototype.process = function(type) {
    this.hardwareButtons.setState('base', type);
  };

  /**
   * We enter the systemlog home state when the user presses the Power button
   * and Volume Down button within less than HOLD_INTERVAL of each other
   * We can fire home or holdhome events from this state
   *
   * @class HardwareButtonsSystemLogState
   */
  HardwareButtonsSystemLogState =
    HardwareButtons.STATES.systemlog =
    function HardwareButtonsSystemLogState(hb) {
      this.hardwareButtons = hb;
      this.timer = undefined;
    };

  /**
   * Entering the state.
   * @memberof HardwareButtonsSystemLogState.prototype
   */
  HardwareButtonsSystemLogState.prototype.enter = function() {
    this.timer = setTimeout(function() {
      /**
       * When the user holds Volume Up and Volume Down button
       * more than HOLD_INTERVAL.
       * @event HardwareButtonsHomeState#volumeup+volumedown
       */
      this.hardwareButtons.publish('volumeup+volumedown');
      this.hardwareButtons.setState('base');
    }.bind(this), this.hardwareButtons.HOLD_INTERVAL);
  };

  /**
   * Leaving the state.
   * @memberof HardwareButtonsSystemLogState.prototype
   */
  HardwareButtonsSystemLogState.prototype.exit = function() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  };

  /**
   * Pressing any other hardware button will cancel this state.
   * @memberof HardwareButtonsSystemLogState.prototype
   * @param  {String} type Name of the event to process.
   */
  HardwareButtonsSystemLogState.prototype.process = function(type) {
    this.hardwareButtons.setState('base', type);
  };

  /**
   * We enter the camera state when the user presses the Camera button
   * We can fire camera or holdcamera events from this state
   *
   * @class HardwareButtonsCameraState
   */
  HardwareButtonsCameraState =
    HardwareButtons.STATES.camera = function HardwareButtonsCameraState(hb) {
      this.hardwareButtons = hb;
      this.timer = undefined;
    };

  /**
   * Entering the state.
   * @memberof HardwareButtonsCameraState.prototype
   */
  HardwareButtonsCameraState.prototype.enter = function() {
    this.timer = setTimeout(function() {
      /**
       * When the user holds Camera button more than HOLD_INTERVAL.
       * @event HardwareButtonsCameraState#holdcamera
       */
      this.hardwareButtons.publish('holdcamera');
      navigator.vibrate(50);
      this.hardwareButtons.setState('base');
    }.bind(this), this.hardwareButtons.HOLD_INTERVAL);
  };

  /**
   * Leaving the state.
   * @memberof HardwareButtonsCameraState.prototype
   */
  HardwareButtonsCameraState.prototype.exit = function() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  };

  /**
   * Process the event, maybe transition the state.
   * @memberof HardwareButtonsCameraState.prototype
   * @param  {String} type Name of the event to process.
   */
  HardwareButtonsCameraState.prototype.process = function(type) {
    switch (type) {
      case 'camera-button-release':
        /**
         * When the user releases Camera button before HOLD_INTERVAL.
         * @event HardwareButtonsCameraState#camera
         */
        this.hardwareButtons.setState('base', type);
        return;
    }
    this.hardwareButtons.setState('base', type);
  };

  exports.HardwareButtons = HardwareButtons;
}(window));
