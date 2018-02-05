const requireg = require('requireg');
const Helper = require('../helper');
const Locator = require('../locator');
const stringIncludes = require('../assert/include').includes;
const { urlEquals } = require('../assert/equal');
const { equals } = require('../assert/equal');
const { empty } = require('../assert/empty');
const { truth } = require('../assert/truth');
const {
  xpathLocator,
  fileExists,
  clearString,
  decodeUrl,
  chunkArray,
  convertCssPropertiesToCamelCase,
} = require('../utils');
const path = require('path');
const ElementNotFound = require('./errors/ElementNotFound');
const Popup = require('./extras/Popup');
const Console = require('./extras/Console');

const puppeteer = requireg('puppeteer');

const popupStore = new Popup();
const consoleLogStore = new Console();

/**
 * Uses [Google Chrome's Puppeteer](https://github.com/GoogleChrome/puppeteer) library to run tests inside headless Chrome.
 * Browser control is executed via DevTools without Selenium.
 * This helper works with a browser out of the box with no additional tools required to install.
 *
 * Requires `puppeteer` package to be installed.
 *
 * ## Configuration
 *
 * This helper should be configured in codecept.json
 *
 * * `url` - base url of website to be tested
 * * `show` (optional, default: false) - show Google Chrome window for debug.
 * * `disableScreenshots` (optional, default: false)  - don't save screenshot on failure.
 * * `uniqueScreenshotNames` (optional, default: false)  - option to prevent screenshot override if you have scenarios with the same name in different suites.
 * * `waitForAction`: (optional) how long to wait after click, doubleClick or PressKey actions in ms. Default: 100.
 * * `waitForTimeout`: (optional) default wait* timeout in ms. Default: 1000.
 * * `windowSize`: (optional) default window size. Set a dimension like `640x480`.
 * * `chrome`: (optional) pass additional [Puppeteer run options](https://github.com/GoogleChrome/puppeteer/blob/master/docs/api.md#puppeteerlaunchoptions). Example
 *
 * ```js
 * "chrome": {
 *   "executablePath" : "/path/to/Chrome"
 * }
 * ```
 */
class Puppeteer extends Helper {
  constructor(config) {
    super(config);

    // set defaults
    this.options = {
      waitForAction: 100,
      waitForTimeout: 1000,
      fullPageScreenshots: true,
      disableScreenshots: false,
      uniqueScreenshotNames: false,
      restart: true,
      show: false,
      defaultPopupAction: 'accept',
    };

    this.isRunning = false;

    // override defaults with config
    Object.assign(this.options, config);
    this.puppeteerOptions = Object.assign({ headless: !this.options.show }, this.options.chrome);
    popupStore.defaultAction = this.options.defaultPopupAction;
  }

  static _config() {
    return [
      { name: 'url', message: 'Base url of site to be tested', default: 'http://localhost' },
    ];
  }

  static _checkRequirements() {
    try {
      requireg('puppeteer');
    } catch (e) {
      return ['puppeteer'];
    }
  }

  _init() {
  }

  _beforeSuite() {
    if (!this.options.restart && !this.options.manualStart && !this.isRunning) {
      this.debugSection('Session', 'Starting singleton browser session');
      return this._startBrowser();
    }
  }


  async _before() {
    return this._startBrowser();
  }

  async _after() {
    return this._stopBrowser();
  }

  /**
   * Set the automatic popup response to Accept.
   * This must be set before a popup is triggered.
   *
   * ```js
   * I.amAcceptingPopups();
   * I.click('#triggerPopup');
   * I.acceptPopup();
   * ```
   */
  amAcceptingPopups() {
    popupStore.actionType = 'accept';
  }

  /**
   * Accepts the active JavaScript native popup window, as created by window.alert|window.confirm|window.prompt.
   * Don't confuse popups with modal windows, as created by [various
   * libraries](http://jster.net/category/windows-modals-popups).
   */
  acceptPopup() {
    popupStore.assertPopupActionType('accept');
  }

  /**
   * Set the automatic popup response to Cancel/Dismiss.
   * This must be set before a popup is triggered.
   *
   * ```js
   * I.amCancellingPopups();
   * I.click('#triggerPopup');
   * I.cancelPopup();
   * ```
   */
  amCancellingPopups() {
    popupStore.actionType = 'cancel';
  }

  /**
   * Dismisses the active JavaScript popup, as created by window.alert|window.confirm|window.prompt.
   */
  cancelPopup() {
    popupStore.assertPopupActionType('cancel');
  }

  /**
   * Checks that the active JavaScript popup, as created by `window.alert|window.confirm|window.prompt`, contains the
   * given string.
   */
  async seeInPopup(text) {
    popupStore.assertPopupVisible();
    const popupText = await popupStore.popup.message();
    stringIncludes('text in popup').assert(text, popupText);
  }

  /**
   * Set current page
   * @param {object} page page to set
   */
  _setPage(page) {
    this._addPopupListener(page);
    this.page = page;
  }

  /**
   * Add the 'dialog' event listener to a page
   * @page {Puppeteer.Page}
   *
   * The popup listener handles the dialog with the predefined action when it appears on the page.
   * It also saves a reference to the object which is used in seeInPopup.
   */
  _addPopupListener(page) {
    if (!page) {
      return;
    }
    page.on('dialog', async (dialog) => {
      popupStore.popup = dialog;
      const action = popupStore.actionType || this.options.defaultPopupAction;
      await this._waitForAction();

      switch (action) {
        case 'accept':
          return dialog.accept();

        case 'cancel':
          return dialog.dismiss();

        default: {
          throw new Error('Unknown popup action type. Only "accept" or "cancel" are accepted');
        }
      }
    });
  }

  /**
   * Grab the text within the popup. If no popup is visible then it will return null
   *
   * ```js
   * await I.grabPopupText();
   * ```
   */
  async grabPopupText() {
    if (popupStore.popup) {
      return popupStore.popup.message();
    }
    return null;
  }

  async _startBrowser() {
    this.browser = await puppeteer.launch(this.puppeteerOptions);
    this.browser.on('targetcreated', (target) => {
      target.page().then((page) => {
        if (!page) return;
        this.withinLocator = null;
        page.on('load', frame => this.context = page.$('body'));
        page.on('console', (msg) => {
          this.debugSection(msg.type(), msg.args().join(' '));
          consoleLogStore.add(msg);
        });
      });
    });

    this.browser.on('targetchanged', (target) => {
      this.debugSection('Url', target.url());
    });

    this._setPage(await this.browser.newPage());

    if (this.options.windowSize && this.options.windowSize.indexOf('x') > 0) {
      const dimensions = this.options.windowSize.split('x');
      await this.resizeWindow(parseInt(dimensions[0], 10), parseInt(dimensions[1], 10));
    }
  }

  async _stopBrowser() {
    this.withinLocator = null;
    this._setPage(null);
    this.context = null;
    popupStore.clear();
    await this.browser.close();
  }

  async _evaluateHandeInContext(...args) {
    let context = await this._getContext();

    if (context.constructor.name === 'Frame') {
      // Currently there is no evalateHandle for the Frame object
      // https://github.com/GoogleChrome/puppeteer/issues/1051
      context = await context.executionContext();
    }

    return context.evaluateHandle(...args);
  }


  async _withinBegin(locator) {
    if (this.withinLocator) {
      throw new Error('Can\'t start within block inside another within block');
    }

    const frame = isFrameLocator(locator);

    if (frame) {
      if (Array.isArray(frame)) {
        return this.switchTo(null)
          .then(() => frame.reduce((p, frameLocator) => p.then(() => this.switchTo(frameLocator)), Promise.resolve()));
      }
      await this.switchTo(locator);
      this.withinLocator = new Locator(locator);
      return;
    }

    const els = await this._locate(locator);
    assertElementExists(els, locator);
    this.context = els[0];

    this.withinLocator = new Locator(locator);
  }

  async _withinEnd() {
    this.withinLocator = null;
    this.context = await this.page.mainFrame().$('body');
  }

  /**
   * Opens a web page in a browser. Requires relative or absolute url.
If url starts with `/`, opens a web page of a site defined in `url` config parameter.

```js
I.amOnPage('/'); // opens main page of website
I.amOnPage('https://github.com'); // opens github
I.amOnPage('/login'); // opens a login page
```

@param url url path or global url
   */
  async amOnPage(url) {
    if (url.indexOf('http') !== 0) {
      url = this.options.url + url;
    }
    await this.page.goto(url);
    return this._waitForAction();
  }

  /**
   * Resize the current window to provided width and height.
First parameter can be set to `maximize`

@param width or `maximize`
@param height
   *
   * Unlike other drivers Puppeteer changes the size of a viewport, not the window!
   * Puppeteer does not control the window of a browser so it can't adjust its real size.
   * It also can't maximize a window.
   */
  async resizeWindow(width, height) {
    if (width === 'maximize') {
      throw new Error('Puppeteer can\'t control windows, so it can\'t maximize it');
    }
    await this.page.setViewport({ width, height });
    return this._waitForAction();
  }

  /**
   * Set headers for all next requests
   *
   * ```js
   * I.haveRequestHeaders({
   *    'X-Sent-By': 'CodeceptJS',
   * });
   * ```
   */
  async haveRequestHeaders(customHeaders) {
    if (!customHeaders) {
      throw new Error('Cannot send empty headers.');
    }
    return this.page.setExtraHTTPHeaders(customHeaders);
  }


  /**
   * Moves cursor to element matched by locator.
Extra shift can be set with offsetX and offsetY options

```js
I.moveCursorTo('.tooltip');
I.moveCursorTo('#submit', 5,5);
```

   */
  async moveCursorTo(locator, offsetX = 0, offsetY = 0) {
    const els = await this._locate(locator);
    assertElementExists(els);

    // Use manual mouse.move instead of .hover() so the offset can be added to the coordinates
    const { x, y } = await els[0]._visibleCenter();
    await this.page.mouse.move(x + offsetX, y + offsetY);
    return this._waitForAction();
  }

  /**
   * Drag an item to a destination element.
   *
   * ```js
   * I.dragAndDrop('#dragHandle', '#container');
   * ```
   */
  async dragAndDrop(source, destination) {
    return proceedDragAndDrop.call(this, source, destination);
  }

  /**
   * Reload the current page.

````js
`I.refreshPage();
````

   */
  async refreshPage() {
    return this.page.reload();
  }

  /**
   * Scroll page to the top
   *
   * ```js
   * I.scrollPageToTop();
   * ```
   */
  scrollPageToTop() {
    return this.page.evaluate(() => {
      window.scrollTo(0, 0);
    });
  }

  /**
   * Scroll page to the bottom
   *
   * ```js
   * I.scrollPageToBottom();
   * ```
   */
  scrollPageToBottom() {
    return this.page.evaluate(() => {
      const body = document.body;
      const html = document.documentElement;
      window.scrollTo(0, Math.max(
        body.scrollHeight, body.offsetHeight,
        html.clientHeight, html.scrollHeight, html.offsetHeight,
      ));
    });
  }

  /**
   * Scrolls to element matched by locator.
   * Extra shift can be set with offsetX and offsetY options
   *
   * ```js
   * I.scrollTo('footer');
   * I.scrollTo('#submit', 5,5);
   * ```
   */
  async scrollTo(locator, offsetX = 0, offsetY = 0) {
    const els = await this._locate(locator);
    assertElementExists(els, locator, 'Element');
    const { x, y } = await els[0]._visibleCenter();

    await this.page.evaluate((x, y) => {
      window.scrollTo(x, y);
    }, x + offsetX, y + offsetY);
    return this._waitForAction();
  }

  /**
   * Checks that title contains text.

@param text
   */
  async seeInTitle(text) {
    const title = await this.page.title();
    stringIncludes('web page title').assert(text, title);
  }

  /**
   * Checks that title is equal to provided one.
   *
   * ```js
   * I.seeTitleEquals('Test title.');
   * ```
   */
  async seeTitleEquals(text) {
    const title = await this.page.title();
    return equals('web page title').assert(title, text);
  }

  /**
   * Checks that title does not contain text.

@param text
   */
  async dontSeeInTitle(text) {
    const title = await this.page.title();
    stringIncludes('web page title').negate(text, title);
  }

  /**
   * Retrieves a page title and returns it to test.
Resumes test execution, so **should be used inside a generator with `yield`** operator.

```js
let title = yield I.grabTitle();
```
   */
  async grabTitle() {
    return this.page.title();
  }

  /**
   * Get elements by different locator types, including strict locator
   * Should be used in custom helpers:
   *
   * ```js
   * const elements = await this.helpers['Puppeteer']._locate({name: 'password'});
   * ```
   */
  async _locate(locator) {
    return findElements(await this.context, locator);
  }

  /**
   * Find a checkbox by providing human readable text:
   *
   * ```js
   * this.helpers['Puppeteer']._locateCheckable('I agree with terms and conditions').then // ...
   * ```
   */
  async _locateCheckable(locator) {
    return findCheckable.call(this, locator, this.context);
  }

  /**
   * Find a clickable element by providing human readable text:
   *
   * ```js
   * this.helpers['Puppeteer']._locateClickable('Next page').then // ...
   * ```
   */
  async _locateClickable(locator) {
    const context = await this._getContext();
    return findClickable.call(this, context, locator);
  }

  /**
   * Find field elements by providing human readable text:
   *
   * ```js
   * this.helpers['Puppeteer']._locateFields('Your email').then // ...
   * ```
   */
  async _locateFields(locator) {
    return findFields.call(this, locator);
  }

  /**
   * Switch focus to a particular tab by its number. It waits tabs loading and then switch tab
   *
   * ```js
   * I.switchToNextTab();
   * I.switchToNextTab(2);
   * ```
   */
  async switchToNextTab(num = 1) {
    const pages = await this.browser.pages();
    const index = pages.indexOf(this.page);
    this.withinLocator = null;
    const page = pages[index + num];

    if (!page) {
      throw new Error(`There is no ability to switch to next tab with offset ${num}`);
    }

    this._setPage(page);
    await this.page.bringToFront();
    return this._waitForAction();
  }

  /**
   * Switch focus to a particular tab by its number. It waits tabs loading and then switch tab
   *
   * ```js
   * I.switchToPreviousTab();
   * I.switchToPreviousTab(2);
   * ```
   */
  async switchToPreviousTab(num = 1) {
    const pages = await this.browser.pages();
    const index = pages.indexOf(this.page);
    this.withinLocator = null;
    const page = pages[index - num];

    if (!page) {
      throw new Error(`There is no ability to switch to previous tab with offset ${num}`);
    }

    this._setPage(page);
    await this.page.bringToFront();
    return this._waitForAction();
  }

  /**
   * Close current tab and switches to previous.
   *
   * ```js
   * I.closeCurrentTab();
   * ```
   */
  async closeCurrentTab() {
    const oldPage = this.page;
    await this.switchToPreviousTab();
    return oldPage.close();
  }

  /**
   * Close all tabs except for the current one.
   *
   * ```js
   * I.closeOtherTabs();
   * ```
   */
  async closeOtherTabs() {
    const pages = await this.browser.pages();
    const otherPages = pages.filter(page => page !== this.page);

    let p = Promise.resolve();
    otherPages.forEach((page) => {
      p = p.then(() => page.close());
    });
    return p;
  }

  /**
   * Open new tab and switch to it
   *
   * ```js
   * I.openNewTab();
   * ```
   */
  async openNewTab() {
    this._setPage(await this.browser.newPage());
  }

  /**
   * Checks that a given Element is visible
Element is located by CSS or XPath.

```js
I.seeElement('#modal');
```
@param locator located by CSS|XPath|strict locator
   */

  async seeElement(locator) {
    let els = await this._locate(locator);
    els = await Promise.all(els.map(el => el.boundingBox()));
    return empty('visible elements').negate(els.filter(v => v).fill('ELEMENT'));
  }

  /**
   * Opposite to `seeElement`. Checks that element is not visible

@param locator located by CSS|XPath|Strict locator
   */
  async dontSeeElement(locator) {
    let els = await this._locate(locator);
    els = await Promise.all(els.map(el => el.boundingBox()));
    return empty('visible elements').assert(els.filter(v => v).fill('ELEMENT'));
  }

  /**
   * Checks that a given Element is present in the DOM
Element is located by CSS or XPath.

```js
I.seeElementInDOM('#modal');
```
@param locator located by CSS|XPath|strict locator
   */
  async seeElementInDOM(locator) {
    const els = await this._locate(locator);
    return empty('elements on page').negate(els.filter(v => v).fill('ELEMENT'));
  }

  /**
   * Opposite to `seeElementInDOM`. Checks that element is not on page.

@param locator located by CSS|XPath|Strict locator
   */
  async dontSeeElementInDOM(locator) {
    const els = await this._locate(locator);
    return empty('elements on a page').assert(els.filter(v => v).fill('ELEMENT'));
  }

  /**
   * Perform a click on a link or a button, given by a locator.
If a fuzzy locator is given, the page will be searched for a button, link, or image matching the locator string.
For buttons, the "value" attribute, "name" attribute, and inner text are searched. For links, the link text is searched.
For images, the "alt" attribute and inner text of any parent links are searched.

The second parameter is a context (CSS or XPath locator) to narrow the search.

```js
// simple link
I.click('Logout');
// button of form
I.click('Submit');
// CSS button
I.click('#form input[type=submit]');
// XPath
I.click('//form/*[@type=submit]');
// link in context
I.click('Logout', '#nav');
// using strict locator
I.click({css: 'nav a.login'});
```
@param locator clickable link or button located by text, or any element located by CSS|XPath|strict locator
@param context (optional) element to search in CSS|XPath|Strict locator
   */
  async click(locator, context = null) {
    return proceedClick.call(this, locator, context);
  }

  /**
   * Performs a double-click on an element matched by link|button|label|CSS or XPath.
Context can be specified as second parameter to narrow search.

```js
I.doubleClick('Edit');
I.doubleClick('Edit', '.actions');
I.doubleClick({css: 'button.accept'});
I.doubleClick('.btn.edit');
```

@param locator
@param context
   */
  async doubleClick(locator, context = null) {
    return proceedClick.call(this, locator, context, { clickCount: 2 });
  }

  /**
   * Performs right click on an element matched by CSS or XPath.
   */
  async rightClick(locator, context = null) {
    return proceedClick.call(this, locator, context, { button: 'right' });
  }

  /**
   * Selects a checkbox or radio button.
Element is located by label or name or CSS or XPath.

The second parameter is a context (CSS or XPath locator) to narrow the search.

```js
I.checkOption('#agree');
I.checkOption('I Agree to Terms and Conditions');
I.checkOption('agree', '//form');
```
@param field checkbox located by label | name | CSS | XPath | strict locator
@param context (optional) element located by CSS | XPath | strict locator
   */
  async checkOption(field, context = null) {
    const els = await findCheckable.call(this, field, context);
    assertElementExists(els[0], field, 'Checkbox or radio');
    if (await els[0].getProperty('checked') === true) return;
    await els[0].click();
    return this._waitForAction();
  }

  /**
   * Verifies that the specified checkbox is checked.

```js
I.seeCheckboxIsChecked('Agree');
I.seeCheckboxIsChecked('#agree'); // I suppose user agreed to terms
I.seeCheckboxIsChecked({css: '#signup_form input[type=checkbox]'});
```
@param field located by label|name|CSS|XPath|strict locator
   */
  async seeCheckboxIsChecked(field) {
    return proceedIsChecked.call(this, 'assert', field);
  }

  /**
   * Verifies that the specified checkbox is not checked.

@param field located by label|name|CSS|XPath|strict locator

   */
  async dontSeeCheckboxIsChecked(field) {
    return proceedIsChecked.call(this, 'negate', field);
  }

  /**
   * Presses a key on a focused element.
Speical keys like 'Enter', 'Control', [etc](https://code.google.com/p/selenium/wiki/JsonWireProtocol#/session/:sessionId/element/:id/value)
will be replaced with corresponding unicode.
If modifier key is used (Control, Command, Alt, Shift) in array, it will be released afterwards.

```js
I.pressKey('Enter');
I.pressKey(['Control','a']);
```
@param key

   */
  async pressKey(key) {
    let modifier;
    const modifiers = ['Control', 'Command', 'Shift', 'Alt'];
    if (Array.isArray(key) && modifiers.indexOf(key[0]) > -1) {
      modifier = key[0];
      key = key[1];
    }
    if (modifier) await this.page.keyboard.down(modifier);
    await await this.page.keyboard.press(key);
    if (modifier) await this.page.keyboard.up(modifier);
    return this._waitForAction();
  }

  /**
   * Fills a text field or textarea, after clearing its value, with the given string.
Field is located by name, label, CSS, or XPath.

```js
// by label
I.fillField('Email', 'hello@world.com');
// by name
I.fillField('password', '123456');
// by CSS
I.fillField('form#login input[name=username]', 'John');
// or by strict locator
I.fillField({css: 'form#login input[name=username]'}, 'John');
```
@param field located by label|name|CSS|XPath|strict locator
@param value

   */
  async fillField(field, value) {
    const els = await findFields.call(this, field);
    assertElementExists(els, field, 'Field');
    const el = els[0];
    // await el.focus();
    const tag = await el.getProperty('tagName').then(el => el.jsonValue());
    const editable = await el.getProperty('contenteditable').then(el => el.jsonValue());

    if (tag === 'TEXTAREA' || editable) {
      await this._evaluateHandeInContext(el => el.innerHTML = '', el);
    }
    if (tag === 'INPUT') {
      await this._evaluateHandeInContext(el => el.value = '', el);
    }
    await el.type(value, { delay: 10 });
    return this._waitForAction();
  }


  /**
   * Clears a `<textarea>` or text `<input>` element's value.

```js
I.clearField('Email');
I.clearField('user[email]');
I.clearField('#email');
```
@param field located by label|name|CSS|XPath|strict locator
   */
  async clearField(field) {
    return this.fillField(field, '');
  }

  /**
   * Appends text to a input field or textarea.
Field is located by name, label, CSS or XPath

```js
I.appendField('#myTextField', 'appended');
```
@param field located by label|name|CSS|XPath|strict locator
@param value text value
   */
  async appendField(field, value) {
    const els = await findFields.call(this, field);
    assertElementExists(els, field, 'Field');
    await els[0].press('End');
    await els[0].type(value, { delay: 10 });
    return this._waitForAction();
  }

  /**
   * Checks that the given input field or textarea equals to given value.
For fuzzy locators, fields are matched by label text, the "name" attribute, CSS, and XPath.

```js
I.seeInField('Username', 'davert');
I.seeInField({css: 'form textarea'},'Type your comment here');
I.seeInField('form input[type=hidden]','hidden_value');
I.seeInField('#searchform input','Search');
```
@param field located by label|name|CSS|XPath|strict locator
@param value
   */
  async seeInField(field, value) {
    return proceedSeeInField.call(this, 'assert', field, value);
  }

  /**
   * Checks that value of input field or textare doesn't equal to given value
Opposite to `seeInField`.

@param field located by label|name|CSS|XPath|strict locator
@param value is not expected to be a field value
   */
  async dontSeeInField(field, value) {
    return proceedSeeInField.call(this, 'negate', field, value);
  }


  /**
   * Attaches a file to element located by label, name, CSS or XPath
Path to file is relative current codecept directory (where codecept.json is located).
File will be uploaded to remote system (if tests are running remotely).

```js
I.attachFile('Avatar', 'data/avatar.jpg');
I.attachFile('form input[name=avatar]', 'data/avatar.jpg');
```
@param locator field located by label|name|CSS|XPath|strict locator
@param pathToFile local file path relative to codecept.json config file

   *
   */
  async attachFile(locator, pathToFile) {
    const file = path.join(global.codecept_dir, pathToFile);

    if (!fileExists(file)) {
      throw new Error(`File at ${file} can not be found on local system`);
    }
    const els = await findFields.call(this, locator);
    assertElementExists(els, 'Field');
    await els[0].uploadFile(file);
    return this._waitForAction();
  }

  /**
   * Selects an option in a drop-down select.
Field is searched by label | name | CSS | XPath.
Option is selected by visible text or by value.

```js
I.selectOption('Choose Plan', 'Monthly'); // select by label
I.selectOption('subscription', 'Monthly'); // match option by text
I.selectOption('subscription', '0'); // or by value
I.selectOption('//form/select[@name=account]','Premium');
I.selectOption('form select[name=account]', 'Premium');
I.selectOption({css: 'form select[name=account]'}, 'Premium');
```

Provide an array for the second argument to select multiple options.

```js
I.selectOption('Which OS do you use?', ['Android', 'iOS']);
```
@param select field located by label|name|CSS|XPath|strict locator
@param option

   */
  async selectOption(select, option) {
    const els = await findFields.call(this, select);
    assertElementExists(els, select, 'Selectable field');
    const el = els[0];
    if (await el.getProperty('tagName').then(t => t.jsonValue()) !== 'SELECT') {
      throw new Error('Element is not <select>');
    }
    if (!Array.isArray(option)) option = [option];

    for (const key in option) {
      const opt = xpathLocator.literal(option[key]);
      let optEl = await findElements.call(this, el, { xpath: Locator.select.byVisibleText(opt) });
      if (optEl.length) {
        this._evaluateHandeInContext(el => el.selected = true, optEl[0]);
        continue;
      }
      optEl = await findElements.call(this, el, { xpath: Locator.select.byValue(opt) });
      if (optEl.length) {
        this._evaluateHandeInContext(el => el.selected = true, optEl[0]);
      }
    }
    await this._evaluateHandeInContext((element) => {
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    }, el);

    return this._waitForAction();
  }

  /**
   * Grab number of visible elements by locator
   *
   * ```js
   * I.grabNumberOfVisibleElements('p');
   * ```
   */
  async grabNumberOfVisibleElements(locator) {
    let els = await this._locate(locator);
    assertElementExists(els, locator);
    els = await Promise.all(els.map(el => el.boundingBox()));
    return els.filter(v => v).length;
  }

  /**
   * Checks that current url contains a provided fragment.

```js
I.seeInCurrentUrl('/register'); // we are on registration page
```
@param url
   */
  async seeInCurrentUrl(url) {
    const currentUrl = this.page.url();
    stringIncludes('url').assert(url, currentUrl);
  }

  /**
   * Checks that current url does not contain a provided fragment.

@param url
   */
  async dontSeeInCurrentUrl(url) {
    const currentUrl = await this.page.url();
    stringIncludes('url').negate(url, currentUrl);
  }

  /**
   * Checks that current url is equal to provided one.
If a relative url provided, a configured url will be prepended to it.
So both examples will work:

```js
I.seeCurrentUrlEquals('/register');
I.seeCurrentUrlEquals('http://my.site.com/register');
```
@param url
   */
  async seeCurrentUrlEquals(url) {
    const currentUrl = await this.page.url();
    urlEquals(this.options.url).assert(url, currentUrl);
  }

  /**
   * Checks that current url is not equal to provided one.
If a relative url provided, a configured url will be prepended to it.

@param url
   */
  async dontSeeCurrentUrlEquals(url) {
    const currentUrl = await this.page.url();
    urlEquals(this.options.url).negate(url, currentUrl);
  }

  /**
   * Checks that a page contains a visible text.
Use context parameter to narrow down the search.

```js
I.see('Welcome'); // text welcome on a page
I.see('Welcome', '.content'); // text inside .content div
I.see('Register', {css: 'form.register'}); // use strict locator
```
@param text expected on page
@param context (optional) element located by CSS|Xpath|strict locator in which to search for text
   */
  async see(text, context = null) {
    return proceedSee.call(this, 'assert', text, context);
  }

  /**
   * Checks that text is equal to provided one.
   *
   * ```js
   * I.seeTextEquals('text', 'h1');
   * ```
   */
  async seeTextEquals(text, context = null) {
    return proceedSee.call(this, 'assert', text, context, true);
  }

  /**
   * Opposite to `see`. Checks that a text is not present on a page.
Use context parameter to narrow down the search.

```js
I.dontSee('Login'); // assume we are already logged in
```
@param text is not present
@param context (optional) element located by CSS|XPath|strict locator in which to perfrom search
   */
  async dontSee(text, context = null) {
    return proceedSee.call(this, 'negate', text, context);
  }

  /**
   * Checks that the current page contains the given string in its raw source code.

```js
I.seeInSource('<h1>Green eggs &amp; ham</h1>');
```
@param text
   */
  async grabSource() {
    return this.page.content();
  }

  /**
   * Get JS log from browser.
   *
   * ```js
   * let logs = yield I.grabBrowserLogs();
   * console.log(JSON.stringify(logs))
   * ```
   */
  async grabBrowserLogs() {
    const logs = consoleLogStore.entries;
    consoleLogStore.clear();
    return logs;
  }

  /**
   * Checks that the current page contains the given string in its raw source code.

```js
I.seeInSource('<h1>Green eggs &amp; ham</h1>');
```
@param text
   */
  async seeInSource(text) {
    const source = await this.page.content();
    stringIncludes('HTML source of a page').assert(text, source);
  }

  /**
   * Checks that the current page contains the given string in its raw source code

@param text
   */
  async dontSeeInSource(text) {
    const source = await this.page.content();
    stringIncludes('HTML source of a page').negate(text, source);
  }


  /**
   * asserts that an element appears a given number of times in the DOM
   * Element is located by label or name or CSS or XPath.
   *
   * ```js
   * I.seeNumberOfElements('#submitBtn', 1);
   * ```
   */
  async seeNumberOfElements(selector, num) {
    const elements = await this._locate(selector);
    return equals(`expected number of elements (${selector}) is ${num}, but found ${elements.length}`).assert(elements.length, num);
  }

  /**
   * asserts that an element is visible a given number of times
   * Element is located by CSS or XPath.
   *
   * ```js
   * I.seeNumberOfVisibleElements('.buttons', 3);
   * ```
   */
  async seeNumberOfVisibleElements(locator, num) {
    const res = await this.grabNumberOfVisibleElements(locator);
    return equals(`expected number of visible elements (${locator}) is ${num}, but found ${res}`).assert(res, num);
  }

  /**
   * Sets a cookie

```js
I.setCookie({name: 'auth', value: true});
```
@param cookie
   */
  async setCookie(cookie) {
    return this.page.setCookie(cookie);
  }

  /**
   * Checks that cookie with given name exists.

```js
I.seeCookie('Auth');
```
@param name
   *
   */
  async seeCookie(name) {
    const cookies = await this.page.cookies();
    empty(`cookie ${name} to be set`).negate(cookies.filter(c => c.name === name));
  }

  /**
   * Checks that cookie with given name does not exist.

@param name
   */
  async dontSeeCookie(name) {
    const cookies = await this.page.cookies();
    empty(`cookie ${name} to be set`).assert(cookies.filter(c => c.name === name));
  }

  /**
   * Gets a cookie object by name
* Resumes test execution, so **should be used inside a generator with `yield`** operator.

```js
let cookie = I.grabCookie('auth');
assert(cookie.value, '123456');
```
@param name
   *
   * Returns cookie in JSON format. If name not passed returns all cookies for this domain.
   */
  async grabCookie(name) {
    const cookies = await this.page.cookies();
    if (!name) return cookies;
    const cookie = cookies.filter(c => c.name === name);
    if (cookie[0]) return cookie[0];
  }

  /**
   * Clears a cookie by name,
if none provided clears all cookies

```js
I.clearCookie();
I.clearCookie('test');
```
@param cookie (optional)
   */
  async clearCookie(name) {
    const cookies = await this.page.cookies();
    if (!name) {
      return this.page.deleteCookie.apply(this.page, cookies);
    }
    const cookie = cookies.filter(c => c.name === name);
    if (!cookie[0]) return;
    return this.page.deleteCookie(cookie[0]);
  }

  /**
   * Executes sync script on a page.
Pass arguments to function as additional parameters.
Will return execution result to a test.
In this case you should use generator and yield to receive results.

Example with jQuery DatePicker:

```js
// change date of jQuery DatePicker
I.executeScript(function() {
  // now we are inside browser context
  $('date').datetimepicker('setDate', new Date());
});
```
Can return values. Don't forget to use `yield` to get them.

```js
let date = yield I.executeScript(function(el) {
  // only basic types can be returned
  return $(el).datetimepicker('getDate').toString();
}, '#date'); // passing jquery selector
```

@param fn function to be executed in browser context
@param ...args args to be passed to function

   *
   * If a function returns a Promise It will wait for it resolution.
   */
  async executeScript(fn) {
    return this.page.evaluate.apply(this.page, arguments);
  }

  /**
   * Executes async script on page.
Provided function should execute a passed callback (as first argument) to signal it is finished.

Example: In Vue.js to make components completely rendered we are waiting for [nextTick](https://vuejs.org/v2/api/#Vue-nextTick).

```js
I.executeAsyncScript(function(done) {
  Vue.nextTick(done); // waiting for next tick
});
```

By passing value to `done()` function you can return values.
Additional arguments can be passed as well, while `done` function is always last parameter in arguments list.

```js
let val = yield I.executeAsyncScript(function(url, done) {
 // in browser context
 $.ajax(url, { success: (data) => done(data); }
}, 'http://ajax.callback.url/');
```

@param fn function to be executed in browser context
@param ...args args to be passed to function
   *
   * Asynchronous scripts can also be executed with `executeScript` if a function returns a Promise.
   */
  async executeAsyncScript(fn) {
    const args = Array.from(arguments);
    const asyncFn = function () {
      const args = Array.from(arguments);
      const fn = eval(args.shift()); // eslint-disable-line no-eval
      return new Promise((done) => {
        args.push(done);
        fn.apply(null, args);
      });
    };
    args[0] = args[0].toString();
    args.unshift(asyncFn);
    return this.page.evaluate.apply(this.page, args);
  }


  /**
   * Retrieves a text from an element located by CSS or XPath and returns it to test.
Resumes test execution, so **should be used inside a generator with `yield`** operator.

```js
let pin = yield I.grabTextFrom('#pin');
```
@param locator element located by CSS|XPath|strict locator
   */
  async grabTextFrom(locator) {
    const els = await this._locate(locator);
    assertElementExists(els, locator);
    return els[0].getProperty('innerText').then(t => t.jsonValue());
  }

  /**
   * Retrieves a value from a form element located by CSS or XPath and returns it to test.
Resumes test execution, so **should be used inside a generator with `yield`** operator.

```js
let email = yield I.grabValueFrom('input[name=email]');
```
@param locator field located by label|name|CSS|XPath|strict locator
   */
  async grabValueFrom(locator) {
    const els = await findFields.call(this, locator);
    assertElementExists(els, locator);
    return els[0].getProperty('value').then(t => t.jsonValue());
  }

  /**
   * Retrieves the innerHTML from an element located by CSS or XPath and returns it to test.
   * Resumes test execution, so **should be used inside a generator with `yield`** operator.
   * Appium: support only web testing
   *
   *
   * ```js
   * let postHTML = yield I.grabHTMLFrom('#post');
   * ```
   */
  async grabHTMLFrom(locator) {
    const els = await this._locate(locator);
    assertElementExists(els, locator);
    const values = await Promise.all(els.map(el => this.page.evaluate(element => element.innerHTML, el)));
    if (Array.isArray(values) && values.length === 1) {
      return values[0];
    }
    return values;
  }

  /**
   * Grab CSS property for given locator
   *
   * ```js
   * I.grabCssPropertyFrom('h3', 'font-weight');
   * ```
   */
  async grabCssPropertyFrom(locator, cssProperty) {
    const els = await this._locate(locator);
    const res = await Promise.all(els.map(el => el.executionContext().evaluate(el => JSON.parse(JSON.stringify(getComputedStyle(el))), el)));
    const cssValues = res.map(props => props[cssProperty]);

    if (res.length > 0) {
      return cssValues;
    }
    return cssValues[0];
  }

  /**
   * Checks that all elements with given locator have given CSS properties.
   *
   * ```js
   * I.seeCssPropertiesOnElements('h3', { 'font-weight': 'bold' });
   * ```
   */
  async seeCssPropertiesOnElements(locator, cssProperties) {
    const res = await this._locate(locator);
    assertElementExists(res, locator);

    const cssPropertiesCamelCase = convertCssPropertiesToCamelCase(cssProperties);
    const elemAmount = res.length;
    const commands = [];
    res.forEach((el) => {
      Object.keys(cssPropertiesCamelCase).forEach((prop) => {
        commands.push(el.executionContext()
          .evaluate((el) => {
            const style = window.getComputedStyle ? getComputedStyle(el) : el.currentStyle;
            return JSON.parse(JSON.stringify(style));
          }, el)
          .then((props) => {
            return props[prop];
          }));
      });
    });
    let props = await Promise.all(commands);
    const values = Object.keys(cssPropertiesCamelCase).map(key => cssPropertiesCamelCase[key]);
    if (!Array.isArray(props)) props = [props];
    let chunked = chunkArray(props, values.length);
    chunked = chunked.filter((val) => {
      for (let i = 0; i < val.length; ++i) {
        if (val[i] !== values[i]) return false;
      }
      return true;
    });
    return equals(`all elements (${locator}) to have CSS property ${JSON.stringify(cssProperties)}`).assert(chunked.length, elemAmount);
  }

  /**
   * Checks that all elements with given locator have given attributes.
   *
   * ```js
   * I.seeAttributesOnElements('//form', {'method': "post"});
   * ```
   */
  async seeAttributesOnElements(locator, attributes) {
    const res = await this._locate(locator);
    assertElementExists(res, locator);

    const elemAmount = res.length;
    const commands = [];
    res.forEach((el) => {
      Object.keys(attributes).forEach((prop) => {
        commands.push(el
          .executionContext()
          .evaluateHandle((el, attr) => el[attr] || el.getAttribute(attr), el, prop)
          .then(el => el.jsonValue()));
      });
    });
    let attrs = await Promise.all(commands);
    const values = Object.keys(attributes).map(key => attributes[key]);
    if (!Array.isArray(attrs)) attrs = [attrs];
    let chunked = chunkArray(attrs, values.length);
    chunked = chunked.filter((val) => {
      for (let i = 0; i < val.length; ++i) {
        if (val[i] !== values[i]) return false;
      }
      return true;
    });
    return equals(`all elements (${locator}) to have attributes ${JSON.stringify(attributes)}`).assert(chunked.length, elemAmount);
  }

  /**
   * Retrieves an attribute from an element located by CSS or XPath and returns it to test.
Resumes test execution, so **should be used inside a generator with `yield`** operator.

```js
let hint = yield I.grabAttributeFrom('#tooltip', 'title');
```
@param locator element located by CSS|XPath|strict locator
@param attr
   */
  async grabAttributeFrom(locator, attr) {
    const els = await this._locate(locator);
    assertElementExists(els, locator);
    return this._evaluateHandeInContext((el, attr) => el[attr] || el.getAttribute(attr), els[0], attr)
      .then(t => t.jsonValue());
  }

  /**
   * Saves a screenshot to ouput folder (set in codecept.json).
Filename is relative to output folder. 
Optionally resize the window to the full available page `scrollHeight` and `scrollWidth` to capture the entire page by passing `true` in as the second argument.

```js
I.saveScreenshot('debug.png');
I.saveScreenshot('debug.png',true) \\resizes to available scrollHeight and scrollWidth before taking screenshot
```
@param fileName
@param fullPage (optional)
   */
  async saveScreenshot(fileName, fullPage = this.options.fullPageScreenshots) {
    const outputFile = path.join(global.output_dir, fileName);
    this.debug(`Screenshot is saving to ${outputFile}`);
    return this.page.screenshot({ path: outputFile, fullPage, type: 'png' });
  }

  async _failed(test) {
    const promisesList = [];
    await this._withinEnd();
    if (!this.options.disableScreenshots) {
      let fileName = clearString(test.title);
      if (test.ctx && test.ctx.test && test.ctx.test.type === 'hook') fileName = clearString(`${test.title}_${test.ctx.test.title}`);
      if (this.options.uniqueScreenshotNames) {
        const uuid = test.uuid || test.ctx.test.uuid;
        fileName = `${fileName.substring(0, 10)}_${uuid}.failed.png`;
      } else {
        fileName += '.failed.png';
      }
      await this.saveScreenshot(fileName, true);
    }
  }

  /**
   * Pauses execution for a number of seconds.

```js
I.wait(2); // wait 2 secs
```

@param sec
   */
  async wait(sec) {
    return new Promise(((done) => {
      setTimeout(done, sec * 1000);
    }));
  }

  /**
   * Waits for element to be present on page (by default waits for 1sec).
Element can be located by CSS or XPath.

```js
I.waitForElement('.btn.continue');
I.waitForElement('.btn.continue', 5); // wait for 5 secs
```

@param locator element located by CSS|XPath|strict locator
@param sec time seconds to wait, 1 by default
   */
  async waitForElement(locator, sec) {
    const waitTimeout = sec ? sec * 1000 : this.options.waitForTimeout;
    locator = new Locator(locator, 'css');

    let waiter;
    const context = await this._getContext();
    if (locator.isCSS()) {
      waiter = context.waitForSelector(locator.simplify(), { timeout: waitTimeout });
    } else {
      waiter = context.waitForFunction($XPath, { timeout: waitTimeout }, null, locator.value);
    }
    return waiter.catch((err) => {
      throw new Error(`element (${locator.toString()}) still not present on page after ${waitTimeout / 1000} sec\n${err.message}`);
    });
  }

  /**
   * Waits for an element to become visible on a page (by default waits for 1sec).
Element can be located by CSS or XPath.

```
I.waitForVisible('#popup');
```

@param locator element located by CSS|XPath|strict locator
@param sec time seconds to wait, 1 by default
   */
  async waitForVisible(locator, sec) {
    const waitTimeout = sec ? sec * 1000 : this.options.waitForTimeout;
    locator = new Locator(locator, 'css');
    const matcher = await this.context;
    let waiter;
    const context = await this._getContext();
    if (locator.isCSS()) {
      waiter = context.waitForSelector(locator.simplify(), { timeout: waitTimeout, visible: true });
    } else {
      const visibleFn = function (locator, $XPath) {
        eval($XPath); // eslint-disable-line no-eval
        return $XPath(null, locator).filter(el => el.offsetParent !== null).length > 0;
      };
      waiter = context.waitForFunction(visibleFn, { timeout: waitTimeout }, locator.value, $XPath.toString());
    }
    return waiter.catch((err) => {
      throw new Error(`element (${locator.toString()}) still not visible after ${waitTimeout / 1000} sec\n${err.message}`);
    });
  }

  /**
   * Waits for an element to become invisible on a page (by default waits for 1sec).
Element can be located by CSS or XPath.

```
I.waitForInvisible('#popup');
```

@param locator element located by CSS|XPath|strict locator
@param sec time seconds to wait, 1 by default

   */
  async waitForInvisible(locator, sec) {
    const waitTimeout = sec ? sec * 1000 : this.options.waitForTimeout;
    locator = new Locator(locator, 'css');
    const matcher = await this.context;
    let waiter;
    const context = await this._getContext();
    if (locator.isCSS()) {
      waiter = context.waitForSelector(locator.simplify(), { timeout: waitTimeout, hidden: true });
    } else {
      const visibleFn = function (locator, $XPath) {
        eval($XPath); // eslint-disable-line no-eval
        return $XPath(null, locator).filter(el => el.offsetParent === null).length > 0;
      };
      waiter = context.waitForFunction(visibleFn, { timeout: waitTimeout }, locator.value, $XPath.toString());
    }
    return waiter.catch((err) => {
      throw new Error(`element (${locator.toString()}) still visible after ${waitTimeout / 1000} sec\n${err.message}`);
    });
  }

  /**
   * Waits for an element to hide (by default waits for 1sec).
Element can be located by CSS or XPath.

```
I.waitToHide('#popup');
```

@param locator element located by CSS|XPath|strict locator
@param sec time seconds to wait, 1 by default

   */
  async waitToHide(locator, sec) {
    const waitTimeout = sec ? sec * 1000 : this.options.waitForTimeout;
    locator = new Locator(locator, 'css');
    let waiter;
    const context = await this._getContext();
    if (locator.isCSS()) {
      waiter = context.waitForSelector(locator.simplify(), { timeout: waitTimeout, hidden: true });
    } else {
      const visibleFn = function (locator, $XPath) {
        eval($XPath); // eslint-disable-line no-eval
        return $XPath(null, locator).filter(el => el.offsetParent !== null).length === 0;
      };
      waiter = context.waitForFunction(visibleFn, { timeout: waitTimeout }, locator.value, $XPath.toString());
    }
    return waiter.catch((err) => {
      throw new Error(`element (${locator.toString()}) still not hidden after ${waitTimeout / 1000} sec\n${err.message}`);
    });
  }

  async _getContext() {
    if (this.context && this.context.constructor.name === 'Frame') {
      return this.context;
    }
    return this.page;
  }

  /**
   * Waiting for the part of the URL to match the expected. Useful for SPA to understand that page was changed.
   *
   * ```js
   * I.waitInUrl('/info', 2);
   * ```
   */
  async waitInUrl(urlPart, sec = null) {
    const aSec = sec || this.options.waitForTimeout;
    const waitTimeout = aSec * 1000;

    return this.page.waitForFunction((urlPart) => {
      const currUrl = decodeURIComponent(decodeURIComponent(decodeURIComponent(window.location.href)));
      return currUrl.indexOf(urlPart) > -1;
    }, { timeout: waitTimeout }, urlPart).catch(async (e) => {
      const currUrl = this.page.url(); // Required because the waitForFunction can't return data.
      if (/waiting failed: timeout/i.test(e.message)) {
        throw new Error(`expected url to include ${urlPart}, but found ${currUrl}`);
      } else {
        throw e;
      }
    });
  }

  /**
   * Waits for the entire URL to match the expected
   *
   * ```js
   * I.waitUrlEquals('/info', 2);
   * I.waitUrlEquals('http://127.0.0.1:8000/info');
   * ```
   */
  async waitUrlEquals(urlPart, sec = null) {
    const aSec = sec || this.options.waitForTimeout;
    const waitTimeout = aSec * 1000;

    const baseUrl = this.options.url;
    if (urlPart.indexOf('http') < 0) {
      urlPart = baseUrl + urlPart;
    }

    return this.page.waitForFunction((urlPart) => {
      const currUrl = decodeURIComponent(decodeURIComponent(decodeURIComponent(window.location.href)));
      return currUrl.indexOf(urlPart) > -1;
    }, { timeout: waitTimeout }, urlPart).catch(async (e) => {
      const currUrl = this.page.url(); // Required because the waitForFunction can't return data.
      if (/waiting failed: timeout/i.test(e.message)) {
        throw new Error(`expected url to be ${urlPart}, but found ${currUrl}`);
      } else {
        throw e;
      }
    });
  }

  /**
   * Waits for a text to appear (by default waits for 1sec).
Element can be located by CSS or XPath.
Narrow down search results by providing context.

```js
I.waitForText('Thank you, form has been submitted');
I.waitForText('Thank you, form has been submitted', 5, '#modal');
```

@param text to wait for
@param sec seconds to wait
@param context element located by CSS|XPath|strict locator
   */
  async waitForText(text, sec = null, context = null) {
    const aSec = sec || this.options.waitForTimeout;
    const waitTimeout = aSec * 1000;
    let waiter;

    const contextObject = await this._getContext();

    if (context) {
      const locator = new Locator(context, 'css');
      if (locator.isCSS()) {
        waiter = contextObject.waitForFunction((locator, text) => {
          const el = document.querySelector(locator);
          if (!el) return false;
          return el.innerText.indexOf(text) > -1;
        }, { timeout: waitTimeout }, locator.value, text);
      }

      if (locator.isXPath()) {
        waiter = contextObject.waitForFunction((locator, text, $XPath) => {
          const el = $XPath(null, locator);
          if (!el.length) return false;
          return el[0].innerText.indexOf(text) > -1;
        }, { timeout: waitTimeout }, locator.value, text, $XPath);
      }
    } else {
      waiter = contextObject.waitForFunction(text => document.body.innerText.indexOf(text) > -1, { timeout: waitTimeout }, text);
    }

    return waiter.catch((err) => {
      throw new Error(`Text "${text}" was not found on page after ${waitTimeout / 1000} sec\n${err.message}`);
    });
  }

  /**
   * Switches frame or in case of null locator reverts to parent.
   */
  async switchTo(locator) {
    if (!locator) {
      this.context = await this.page.mainFrame().$('body');
      return;
    } else if (Number.isInteger(locator)) {
      // Select by frame index of current context
      const childFrames = this.context ? this.context.childFrames() : this.page.frames();

      if (locator >= 0 && locator < childFrames.length) {
        this.context = childFrames[locator];
      } else {
        throw new Error('Element #invalidIframeSelector was not found by text|CSS|XPath');
      }
      return;
    }

    // iframe by selector
    const els = await this._locate(locator);
    assertElementExists(els, locator);

    const iframeName = await els[0].getProperty('name').then(el => el.jsonValue());
    const iframeId = await els[0].getProperty('id').then(el => el.jsonValue());
    const iframeUrl = await els[0].getProperty('src').then(el => el.jsonValue());

    const searchName = iframeName || iframeId; // Name takes precedence over id, because of puppeteer's Frame.name() function
    const currentContext = await this._getContext();
    const resFrame = await findFrame.call(this, currentContext, searchName, iframeUrl);

    if (resFrame) {
      this.context = resFrame;
    } else {
      this.context = els[0];
    }
  }

  /**
   * Waits for a function to return true (waits for 1sec by default).

```js
I.waitUntil(() => window.requests == 0);
I.waitUntil(() => window.requests == 0, 5);
```

@param function function which is executed in browser context.
@param sec time seconds to wait, 1 by default

   */
  async waitUntil(fn, sec = null) {
    const aSec = sec || this.options.waitForTimeout;
    const waitTimeout = aSec * 1000;
    const context = await this._getContext();
    return context.waitForFunction(fn, { timeout: waitTimeout });
  }

  /**
   * Waits for element not to be present on page (by default waits for 1sec).
Element can be located by CSS or XPath.

```js
I.waitUntilExists('.btn.continue');
I.waitUntilExists('.btn.continue', 5); // wait for 5 secs
```

@param locator element located by CSS|XPath|strict locator
@param sec time seconds to wait, 1 by default

   */
  async waitUntilExists(locator, sec) {
    const waitTimeout = sec ? sec * 1000 : this.options.waitForTimeout;
    locator = new Locator(locator, 'css');

    let waiter;
    const context = await this._getContext();
    if (locator.isCSS()) {
      const visibleFn = function (locator) {
        return document.querySelector(locator) === null;
      };
      waiter = context.waitForFunction(visibleFn, { timeout: waitTimeout }, locator.value);
    } else {
      const visibleFn = function (locator, $XPath) {
        eval($XPath); // eslint-disable-line no-eval
        return $XPath(null, locator).length === 0;
      };
      waiter = context.waitForFunction(visibleFn, { timeout: waitTimeout }, locator.value, $XPath.toString());
    }
    return waiter.catch((err) => {
      throw new Error(`element (${locator.toString()}) still on page after ${waitTimeout / 1000} sec\n${err.message}`);
    });
  }

  async _waitForAction() {
    return this.wait(this.options.waitForAction / 1000);
  }
}

module.exports = Puppeteer;

async function findFrame(context, name, url) {
  if (!context) {
    return;
  }
  let frames = [];
  if (typeof context.childFrames === 'function') {
    frames = context.childFrames();
  } else {
    frames = this.page.frames();
  }

  return frames.find((frame) => {
    if (name || !url) {
      return frame.name() === name;
    }
    return frame.url() === url;
  });
}

async function findElements(matcher, locator) {
  locator = new Locator(locator, 'css');
  if (!locator.isXPath()) return matcher.$$(locator.simplify());

  let context = null;
  if (matcher && matcher.constructor.name === 'ElementHandle') {
    context = matcher;
  }
  if (matcher && matcher.constructor.name === 'Frame') {
    context = matcher;
  }

  return matcher.$x(locator.value, matcher);
}

async function proceedClick(locator, context = null, options = {}) {
  let matcher = await this.context;
  if (context) {
    const els = await this._locate(context);
    assertElementExists(els, context);
    matcher = els[0];
  }
  const els = await findClickable.call(this, matcher, locator);
  if (context) {
    assertElementExists(els, locator, 'Clickable element', `was not found inside element ${new Locator(context).toString()}`);
  } else {
    assertElementExists(els, locator, 'Clickable element');
  }
  await els[0].click(options);
  await this._waitForAction();
}

async function findClickable(matcher, locator) {
  locator = new Locator(locator);
  if (!locator.isFuzzy()) return findElements.call(this, matcher, locator.simplify());

  let els;
  const literal = xpathLocator.literal(locator.value);

  els = await findElements.call(this, matcher, Locator.clickable.narrow(literal));
  if (els.length) return els;

  els = await findElements.call(this, matcher, Locator.clickable.wide(literal));
  if (els.length) return els;

  try {
    els = await findElements.call(this, matcher, Locator.clickable.self(literal));
    if (els.length) return els;
  } catch (err) {
    // Do nothing
  }

  return findElements.call(this, matcher, locator.value); // by css or xpath
}

async function proceedSee(assertType, text, context, strict = false) {
  let description;
  let allText;
  if (!context) {
    let el = await this.context;

    if (el && !el.getProperty) {
      // Fallback to body
      el = await this.context.$('body');
    }

    allText = [await el.getProperty('innerText').then(p => p.jsonValue())];
    description = 'web application';
  } else {
    const locator = new Locator(context, 'css');
    description = `element ${locator.toString()}`;
    const els = await this._locate(locator);
    assertElementExists(els, 'context element');
    allText = await Promise.all(els.map(el => el.getProperty('innerText').then(p => p.jsonValue())));
  }

  if (strict) {
    return allText.map(elText => equals(description)[assertType](text, elText));
  }
  return stringIncludes(description)[assertType](text, allText.join(' | '));
}

async function findCheckable(locator, context) {
  let contextEl = await this.context;
  if (typeof context === 'string') {
    contextEl = await findElements.call(this, contextEl, (new Locator(context, 'css')).simplify());
    contextEl = contextEl[0];
  }

  const matchedLocator = new Locator(locator);
  if (!matchedLocator.isFuzzy()) {
    return findElements.call(this, contextEl, matchedLocator.simplify());
  }

  const literal = xpathLocator.literal(locator);
  let els = await findElements.call(this, contextEl, Locator.checkable.byText(literal));
  if (els.length) {
    return els;
  }
  els = await findElements.call(this, contextEl, Locator.checkable.byName(literal));
  if (els.length) {
    return els;
  }
  return findElements.call(this, contextEl, locator);
}

async function proceedIsChecked(assertType, option) {
  let els = await findCheckable.call(this, option);
  assertElementExists(els, option, 'Checkable');
  els = await Promise.all(els.map(el => el.getProperty('checked')));
  els = await Promise.all(els.map(el => el.jsonValue()));
  const selected = els.reduce((prev, cur) => prev || cur);
  return truth(`checkable ${option}`, 'to be checked')[assertType](selected);
}

async function findFields(locator) {
  const matchedLocator = new Locator(locator);
  if (!matchedLocator.isFuzzy()) {
    return this._locate(matchedLocator);
  }
  const literal = xpathLocator.literal(locator);

  let els = await this._locate({ xpath: Locator.field.labelEquals(literal) });
  if (els.length) {
    return els;
  }

  els = await this._locate({ xpath: Locator.field.labelContains(literal) });
  if (els.length) {
    return els;
  }
  els = await this._locate({ xpath: Locator.field.byName(literal) });
  if (els.length) {
    return els;
  }
  return this._locate({ css: locator });
}

async function proceedDragAndDrop(sourceLocator, destinationLocator, options = {}) {
  const src = await this._locate(sourceLocator);
  assertElementExists(src, sourceLocator, 'Source Element');

  const dst = await this._locate(destinationLocator);
  assertElementExists(dst, destinationLocator, 'Destination Element');

  // Note: Using private api ._visibleCenter becaues the .BoundingBox does not take into account iframe offsets!
  const dragSource = await src[0]._visibleCenter();
  const dragDestination = await dst[0]._visibleCenter();

  // Drag start point
  await this.page.mouse.move(dragSource.x, dragSource.y, { steps: 5 });
  await this.page.mouse.down();

  // Drag destination
  await this.page.mouse.move(dragDestination.x, dragDestination.y, { steps: 5 });
  await this.page.mouse.up();

  await this._waitForAction();
}

async function proceedSeeInField(assertType, field, value) {
  const els = await findFields.call(this, field);
  assertElementExists(els, field, 'Field');
  const el = els[0];
  const tag = await el.getProperty('tagName').then(el => el.jsonValue());
  const fieldType = await el.getProperty('type').then(el => el.jsonValue());

  const proceedMultiple = async (elements) => {
    const fields = Array.isArray(elements) ? elements : [elements];

    const elementValues = [];
    for (const element of fields) {
      elementValues.push(await element.getProperty('value').then(el => el.jsonValue()));
    }

    if (typeof value === 'boolean') {
      equals(`no. of items matching > 0: ${field}`)[assertType](value, !!elementValues.length);
    } else {
      if (assertType === 'assert') {
        equals(`select option by ${field}`)[assertType](true, elementValues.length > 0);
      }
      elementValues.forEach(val => stringIncludes(`fields by ${field}`)[assertType](value, val));
    }
  };

  if (tag === 'SELECT') {
    const selectedOptions = await el.$$('option:checked');
    // locate option by values and check them
    if (value === '') {
      return proceedMultiple(selectedOptions);
    }

    const options = await filterFieldsByValue(selectedOptions, value, true);
    return proceedMultiple(options);
  }

  if (tag === 'INPUT') {
    if (fieldType === 'checkbox' || fieldType === 'radio') {
      if (typeof value === 'boolean') {
        // Filter by values
        const options = await filterFieldsBySelectionState(els, true);
        return proceedMultiple(options);
      }

      const options = await filterFieldsByValue(els, value, true);
      return proceedMultiple(options);
    }
    return proceedMultiple(els[0]);
  }
  const fieldVal = await el.getProperty('value').then(el => el.jsonValue());
  return stringIncludes(`fields by ${field}`)[assertType](value, fieldVal);
}

async function filterFieldsByValue(elements, value, onlySelected) {
  const matches = [];
  for (const element of elements) {
    const val = await element.getProperty('value').then(el => el.jsonValue());
    let isSelected = true;
    if (onlySelected) {
      isSelected = await elementSelected(element);
    }
    if ((value == null || val.indexOf(value) > -1) && isSelected) {
      matches.push(element);
    }
  }
  return matches;
}

async function filterFieldsBySelectionState(elements, state) {
  const matches = [];
  for (const element of elements) {
    const isSelected = await elementSelected(element);
    if (isSelected === state) {
      matches.push(element);
    }
  }
  return matches;
}

async function elementSelected(element) {
  const type = await element.getProperty('type').then(el => el.jsonValue());

  if (type === 'checkbox' || type === 'radio') {
    return element.getProperty('checked').then(el => el.jsonValue());
  }
  return element.getProperty('selected').then(el => el.jsonValue());
}

function isFrameLocator(locator) {
  locator = new Locator(locator);
  if (locator.isFrame()) return locator.value;
  return false;
}


function assertElementExists(res, locator, prefix, suffix) {
  if (!res || res.length === 0) {
    throw new ElementNotFound(locator, prefix, suffix);
  }
}

function $XPath(element, selector) {
  const found = document.evaluate(selector, element || document.body, null, 5, null);
  const res = [];
  let current = null;
  while (current = found.iterateNext()) {
    res.push(current);
  }
  return res;
}

