/**
 * SAIKOON STOCK APPLICATION — PASSWORD RESET CONTROLLER
 * Handles recovery token parsing from URL, client validation, and submission.
 */

(() => {
  'use strict';

  const formContainer = document.querySelector('#reset-form-container');
  const successContainer = document.querySelector('#reset-success-container');
  const invalidContainer = document.querySelector('#reset-invalid-container');

  const form = document.querySelector('#reset-password-form');
  const newPasswordInput = document.querySelector('#new-password');
  const confirmPasswordInput = document.querySelector('#confirm-password');
  const submitBtn = document.querySelector('#reset-submit-btn');
  const btnText = submitBtn?.querySelector('.btn-text');
  const errorBanner = document.querySelector('#reset-error-banner');
  const errorText = document.querySelector('#reset-error-text');

  // Password visibility toggle helpers
  function setupToggle(btnId, inputId) {
    const btn = document.querySelector(btnId);
    const input = document.querySelector(inputId);
    if (!btn || !input) return;

    const openIcon = btn.querySelector('.eye-open');
    const closedIcon = btn.querySelector('.eye-closed');

    btn.addEventListener('click', () => {
      const isPassword = input.getAttribute('type') === 'password';
      input.setAttribute('type', isPassword ? 'text' : 'password');
      if (openIcon) openIcon.classList.toggle('is-hidden', isPassword);
      if (closedIcon) closedIcon.classList.toggle('is-hidden', !isPassword);
      input.focus();
    });
  }

  setupToggle('#new-password-toggle-btn', '#new-password');
  setupToggle('#confirm-password-toggle-btn', '#confirm-password');

  // Parse recovery tokens from URL (hash fragments or query parameters)
  function parseRecoveryParams() {
    const params = {
      accessToken: '',
      tokenHash: '',
      code: '',
      type: '',
    };

    // 1. Hash Fragment (Standard Supabase redirect: #access_token=...&type=recovery)
    const hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash;
    if (hash) {
      const hashParams = new URLSearchParams(hash);
      params.accessToken = hashParams.get('access_token') || '';
      params.type = hashParams.get('type') || '';
    }

    // 2. Query Search (PKCE or direct verify: ?token_hash=... or ?code=...)
    const query = new URLSearchParams(window.location.search);
    if (!params.accessToken && query.get('access_token')) {
      params.accessToken = query.get('access_token');
    }
    params.tokenHash = query.get('token_hash') || query.get('token') || '';
    params.code = query.get('code') || '';
    if (!params.type) {
      params.type = query.get('type') || '';
    }

    return params;
  }

  const recoveryParams = parseRecoveryParams();

  // If there are no recovery parameters present, show invalid link container
  if (!recoveryParams.accessToken && !recoveryParams.tokenHash && !recoveryParams.code) {
    if (formContainer) formContainer.hidden = true;
    if (invalidContainer) invalidContainer.hidden = false;
    return;
  }

  function showError(msg) {
    if (!errorBanner || !errorText) return;
    errorText.textContent = msg;
    errorBanner.hidden = false;
  }

  function hideError() {
    if (!errorBanner) return;
    errorBanner.hidden = true;
  }

  function setLoading(isLoading) {
    if (!submitBtn || !btnText) return;
    if (isLoading) {
      submitBtn.disabled = true;
      submitBtn.classList.add('is-loading');
      btnText.textContent = 'Mise à jour en cours...';
    } else {
      submitBtn.disabled = false;
      submitBtn.classList.remove('is-loading');
      btnText.textContent = 'Mettre à jour le mot de passe';
    }
  }

  if (form) {
    form.addEventListener('submit', async event => {
      event.preventDefault();
      hideError();

      const newPassword = newPasswordInput?.value || '';
      const confirmPassword = confirmPasswordInput?.value || '';

      if (!newPassword) {
        showError('Le mot de passe ne peut pas être vide.');
        newPasswordInput?.focus();
        return;
      }

      if (newPassword.length < 6) {
        showError('Le mot de passe doit comporter au moins 6 caractères.');
        newPasswordInput?.focus();
        return;
      }

      if (newPassword !== confirmPassword) {
        showError('Les mots de passe ne correspondent pas.');
        confirmPasswordInput?.focus();
        return;
      }

      setLoading(true);

      try {
        const response = await fetch('/api/auth/reset-password', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
          },
          body: JSON.stringify({
            new_password: newPassword,
            confirm_password: confirmPassword,
            token_hash: recoveryParams.tokenHash,
            access_token: recoveryParams.accessToken,
            code: recoveryParams.code,
          }),
        });

        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
          const errMsg = data.error || 'Ce lien de réinitialisation est invalide ou a expiré. Veuillez demander un nouveau lien.';
          showError(errMsg);
          setLoading(false);
          return;
        }

        // Show Success Container
        if (formContainer) formContainer.hidden = true;
        if (successContainer) successContainer.hidden = false;

        // Clean URL history to avoid retaining recovery tokens
        if (window.history && window.history.replaceState) {
          window.history.replaceState({}, document.title, window.location.pathname);
        }
      } catch (_) {
        showError('Impossible de joindre le serveur. Veuillez vérifier votre connexion.');
        setLoading(false);
      }
    });
  }
})();
