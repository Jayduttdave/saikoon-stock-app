/**
 * SAIKOON STOCK APPLICATION — LOGIN CONTROLLER
 * Handles password visibility, desktop mouse parallax, and authentication submission.
 */

(() => {
  'use strict';

  // DOM Elements
  const form = document.querySelector('#login-form');
  const emailInput = document.querySelector('#login-email');
  const passwordInput = document.querySelector('#login-password');
  const passwordToggleBtn = document.querySelector('#password-toggle-btn');
  const eyeOpen = document.querySelector('#eye-icon-open');
  const eyeClosed = document.querySelector('#eye-icon-closed');
  const submitBtn = document.querySelector('#login-submit-btn');
  const btnText = submitBtn?.querySelector('.btn-text');
  const errorBanner = document.querySelector('#auth-error-banner');
  const errorText = document.querySelector('#auth-error-text');

  // Forgot password modal
  const forgotLink = document.querySelector('#forgot-password-link');
  const forgotModal = document.querySelector('#forgot-modal');
  const forgotCloseBtn = document.querySelector('#forgot-modal-close-btn');

  /* -------------------------------------------------------------------------
     1. Password Visibility Toggle
     ------------------------------------------------------------------------- */
  if (passwordToggleBtn && passwordInput && eyeOpen && eyeClosed) {
    passwordToggleBtn.addEventListener('click', () => {
      const isPassword = passwordInput.getAttribute('type') === 'password';
      passwordInput.setAttribute('type', isPassword ? 'text' : 'password');

      eyeOpen.classList.toggle('is-hidden', isPassword);
      eyeClosed.classList.toggle('is-hidden', !isPassword);

      const label = isPassword ? 'Masquer le mot de passe' : 'Afficher le mot de passe';
      passwordToggleBtn.setAttribute('aria-label', label);
      passwordToggleBtn.setAttribute('title', label);
      passwordInput.focus();
    });
  }

  /* -------------------------------------------------------------------------
     2. Forgot Password Notice Modal
     ------------------------------------------------------------------------- */
  if (forgotLink && forgotModal && forgotCloseBtn) {
    forgotLink.addEventListener('click', event => {
      event.preventDefault();
      forgotModal.hidden = false;
      forgotCloseBtn.focus();
    });

    forgotCloseBtn.addEventListener('click', () => {
      forgotModal.hidden = true;
      forgotLink.focus();
    });

    forgotModal.addEventListener('click', event => {
      if (event.target === forgotModal) {
        forgotModal.hidden = true;
        forgotLink.focus();
      }
    });

    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !forgotModal.hidden) {
        forgotModal.hidden = true;
        forgotLink.focus();
      }
    });
  }

  /* -------------------------------------------------------------------------
     3. Subtle Mouse Parallax (Desktop Only)
     ------------------------------------------------------------------------- */
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const hasFinePointer = window.matchMedia('(hover: hover) and (pointer: fine)').matches;

  if (!prefersReducedMotion && hasFinePointer) {
    let targetX = 0;
    let targetY = 0;
    let currentX = 0;
    let currentY = 0;
    let isTicking = false;

    window.addEventListener('mousemove', event => {
      const centerX = window.innerWidth / 2;
      const centerY = window.innerHeight / 2;
      targetX = (event.clientX - centerX);
      targetY = (event.clientY - centerY);

      if (!isTicking) {
        window.requestAnimationFrame(updateParallax);
        isTicking = true;
      }
    }, { passive: true });

    function updateParallax() {
      // Smooth linear interpolation (lerp)
      currentX += (targetX - currentX) * 0.08;
      currentY += (targetY - currentY) * 0.08;

      document.documentElement.style.setProperty('--px', `${currentX.toFixed(2)}px`);
      document.documentElement.style.setProperty('--py', `${currentY.toFixed(2)}px`);

      if (Math.abs(targetX - currentX) > 0.1 || Math.abs(targetY - currentY) > 0.1) {
        window.requestAnimationFrame(updateParallax);
      } else {
        isTicking = false;
      }
    }
  }

  /* -------------------------------------------------------------------------
     4. Form Submission & Supabase Auth Connection
     ------------------------------------------------------------------------- */
  function showError(message) {
    if (!errorBanner || !errorText) return;
    errorText.textContent = message;
    errorBanner.hidden = false;

    // Trigger restart of shake animation
    errorBanner.style.animation = 'none';
    // Force reflow
    void errorBanner.offsetWidth;
    errorBanner.style.animation = '';
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
      btnText.textContent = 'Connexion en cours...';
    } else {
      submitBtn.disabled = false;
      submitBtn.classList.remove('is-loading');
      btnText.textContent = 'Se connecter';
    }
  }

  if (form) {
    form.addEventListener('submit', async event => {
      event.preventDefault();
      hideError();

      const email = emailInput?.value.trim() || '';
      const password = passwordInput?.value || '';

      if (!email) {
        showError('Veuillez renseigner votre adresse email.');
        emailInput?.focus();
        return;
      }

      if (!password) {
        showError('Veuillez renseigner votre mot de passe.');
        passwordInput?.focus();
        return;
      }

      setLoading(true);

      try {
        const response = await fetch('/api/auth/login', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
          },
          body: JSON.stringify({ email, password }),
        });

        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
          const errorMsg = data.error || 'Identifiants incorrects. Veuillez vérifier votre adresse email et votre mot de passe.';
          showError(errorMsg);
          setLoading(false);
          if (passwordInput) {
            passwordInput.value = '';
            passwordInput.focus();
          }
          return;
        }

        // Authentication Successful
        if (btnText) {
          btnText.textContent = 'Connexion réussie ✓';
        }
        submitBtn?.classList.remove('is-loading');

        // Smooth redirect to the main application
        const redirectUrl = data.redirect || '/';
        window.location.assign(redirectUrl);
      } catch (err) {
        showError('Impossible de joindre le serveur. Veuillez vérifier votre connexion.');
        setLoading(false);
      }
    });
  }
})();
