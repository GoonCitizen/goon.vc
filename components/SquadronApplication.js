'use strict';

const escapeHtml = require('../functions/escapeHtml');

const GOOGLE_FORM_ACTION = /^https:\/\/docs\.google\.com\/forms\/d\/e\/[\w-]+\/formResponse$/;

/**
 * Native HTML form that posts to a Google Form's `formResponse` endpoint.
 * The response page loads in a hidden iframe so the visitor stays on goon.vc.
 * @param {Object} props
 * @param {string} props.id Element id prefix.
 * @param {Object} props.form
 * @param {string} props.form.action Google Forms `formResponse` URL.
 * @param {string} props.form.viewUrl Public form link (fallback).
 * @param {Array<{ name: string, label: string, type: string, required?: boolean }>} props.form.fields
 * @param {string} [props.submitLabel]
 */
function renderApplicationHtml (props) {
  const form = props.form || {};
  if (!GOOGLE_FORM_ACTION.test(String(form.action || ''))) return '';
  const id = props.id;
  const fields = (form.fields || []).map((field, i) => {
    const fieldId = `${id}-field-${i}`;
    const required = field.required ? ' required' : '';
    const input = field.type === 'paragraph'
      ? `<textarea id="${fieldId}" name="${escapeHtml(field.name)}" rows="4" maxlength="4000"${required}></textarea>`
      : `<input id="${fieldId}" name="${escapeHtml(field.name)}" type="text" maxlength="200" autocomplete="off"${required}>`;
    return `<label class="squadron-field" for="${fieldId}"><span>${escapeHtml(field.label)}${field.required ? ' <em aria-hidden="true">*</em>' : ''}</span>${input}</label>`;
  }).join('\n            ');
  return `<form id="${id}-form" class="squadron-form" method="POST" action="${escapeHtml(form.action)}" target="${id}-sink" accept-charset="UTF-8">
            ${fields}
            <input type="hidden" name="fvv" value="1">
            <input type="hidden" name="pageHistory" value="0">
            <button type="submit" class="squadron-submit">${escapeHtml(props.submitLabel || 'Submit application')}</button>
            <p class="squadron-status" id="${id}-status" role="status" aria-live="polite"></p>
            <p class="squadron-fallback">Trouble submitting? <a href="${escapeHtml(form.viewUrl)}" target="_blank" rel="noopener noreferrer">Open the form on Google Forms</a>.</p>
          </form>
          <iframe name="${id}-sink" id="${id}-sink" title="Application response" hidden></iframe>`;
}

/**
 * @param {Object} props
 * @param {string} props.id Same prefix as render.
 * @param {string} props.successText
 */
function renderApplicationScript (props) {
  return `<script type="text/javascript">
      (function () {
        var form = document.getElementById(${JSON.stringify(props.id + '-form')});
        var sink = document.getElementById(${JSON.stringify(props.id + '-sink')});
        var status = document.getElementById(${JSON.stringify(props.id + '-status')});
        if (!form || !sink) return;
        var button = form.querySelector('button[type="submit"]');
        var pending = false;
        var timer = null;

        function done (ok) {
          pending = false;
          clearTimeout(timer);
          button.disabled = false;
          status.textContent = ok
            ? ${JSON.stringify(props.successText)}
            : 'We could not confirm your application. Please use the Google Forms link below.';
          if (ok) form.reset();
        }

        form.addEventListener('submit', function () {
          pending = true;
          button.disabled = true;
          status.textContent = 'Sending…';
          timer = setTimeout(function () { if (pending) done(false); }, 20000);
        });
        sink.addEventListener('load', function () { if (pending) done(true); });
      })();
    </script>`;
}

module.exports = {
  id: 'squadron-application',
  render: renderApplicationHtml,
  script: renderApplicationScript,
  GOOGLE_FORM_ACTION
};
