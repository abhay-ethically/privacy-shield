/**
 * Screen Privacy Shield - Hover Controller
 * Manages hover-to-reveal timing, modifier key validation, and unblur/re-blur transitions.
 * v2.0: multi-rect group reveal (overlay.__spsGroup) + Present Mode reveal lockout.
 */

(function (global) {
  'use strict';

  class HoverController {
    constructor(options = {}) {
      this.revealDelayMs = options.revealDelayMs || 250;
      this.requireAltKey = options.requireAltKey || false;
      this.onReveal = options.onReveal || (() => {});
      this.onReblur = options.onReblur || (() => {});

      this.isAltPressed = false;
      this.activeHoverOverlay = null;
      this.activeHoverTimer = null;
      this.presentMode = false;
      // Pinned (Alt+Click) reveals: persist after mouseout until toggled,
      // Esc, or Present Mode. Set of primary overlay elements.
      this.pinnedOverlays = new Set();

      this.initKeyListeners();
    }

    isPinned(overlay) {
      const group = overlay.__spsGroup || [overlay];
      return group.some(el => this.pinnedOverlays.has(el));
    }

    isRevealed(overlay) {
      return overlay.classList.contains('sps-revealed') ||
        (overlay.__spsGroup || []).some(el => el.classList.contains('sps-revealed'));
    }

    pin(overlay) {
      this.forEachOverlayEl(overlay, el => this.pinnedOverlays.add(el));
    }

    unpin(overlay) {
      this.forEachOverlayEl(overlay, el => this.pinnedOverlays.delete(el));
    }

    /** Clear every pinned reveal (Esc / Present Mode). */
    unpinAll() {
      for (const el of [...this.pinnedOverlays]) {
        this.unpin(el);
        this.reblur(el);
      }
      this.pinnedOverlays.clear();
    }

    updateSettings(newSettings = {}) {
      if (typeof newSettings.revealDelayMs === 'number') {
        this.revealDelayMs = newSettings.revealDelayMs;
      }
      if (typeof newSettings.requireAltKey === 'boolean') {
        this.requireAltKey = newSettings.requireAltKey;
      }
    }

    /**
     * Present Mode: all reveals are blocked; anything currently revealed
     * or arming is immediately re-blurred.
     */
    setPresentMode(active) {
      this.presentMode = !!active;
      if (this.presentMode) {
        this.clearHoverTimer();
        this.unpinAll(); // deliberate reveals must not survive into a share
        if (this.activeHoverOverlay) {
          this.reblur(this.activeHoverOverlay);
          this.disarmReveal(this.activeHoverOverlay);
          this.activeHoverOverlay = null;
        }
        // Re-blur any other overlay that might be revealed - across the
        // main shadow AND any top-layer shadow containers.
        if (this.overlayManager) {
          const scrub = (sr) => {
            const revealed = sr.querySelectorAll(
              '.sps-blur-overlay.sps-revealed, .sps-blur-overlay.sps-arming');
            for (const el of revealed) {
              el.classList.remove('sps-revealed', 'sps-arming');
            }
          };
          if (this.overlayManager.forEachShadow) {
            this.overlayManager.forEachShadow(scrub);
          } else if (this.overlayManager.shadowRoot) {
            scrub(this.overlayManager.shadowRoot);
          }
          if (this.overlayManager.refreshMasks) this.overlayManager.refreshMasks();
        }
      }
    }

    /** Apply a classList operation to an overlay and all of its group siblings. */
    forEachOverlayEl(overlay, fn) {
      const group = overlay.__spsGroup;
      if (group && group.length) {
        for (const el of group) fn(el);
      } else {
        fn(overlay);
      }
    }

    initKeyListeners() {
      window.addEventListener('keydown', (e) => {
        if (e.key === 'Alt') {
          this.isAltPressed = true;
          this.handleAltStateChange();
        }
      }, { passive: true, capture: true });

      window.addEventListener('keyup', (e) => {
        if (e.key === 'Alt') {
          this.isAltPressed = false;
          this.handleAltStateChange();
        }
      }, { passive: true, capture: true });

      // Handle window blur (e.g. user Alt-tabs away)
      window.addEventListener('blur', () => {
        this.isAltPressed = false;
        this.handleAltStateChange();
      }, { passive: true });

      // Esc clears all pinned reveals - a single "cover everything again" key.
      window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && this.pinnedOverlays.size) {
          this.unpinAll();
        }
      }, { passive: true, capture: true });
    }

    handleAltStateChange() {
      if (!this.activeHoverOverlay || this.presentMode) return;

      const overlay = this.activeHoverOverlay;
      const tooltip = overlay.querySelector('.sps-tooltip');

      if (this.requireAltKey) {
        if (this.isAltPressed) {
          if (tooltip) tooltip.classList.remove('sps-visible');
          if (!overlay.classList.contains('sps-revealed') &&
              !overlay.classList.contains('sps-arming')) {
            this.armReveal(overlay);
          }
        } else {
          // Pinned (Alt+Click) reveals survive the Alt release.
          if (!this.isPinned(overlay) && overlay.classList.contains('sps-revealed')) {
            this.reblur(overlay);
          }
          this.disarmReveal(overlay);
          if (tooltip && !this.isPinned(overlay)) tooltip.classList.add('sps-visible');
        }
      }
    }

    attachToOverlay(overlay, meta) {
      overlay.__spsMeta = meta;

      overlay.addEventListener('mouseenter', () => {
        this.handleMouseEnter(overlay, meta);
      });

      overlay.addEventListener('mouseleave', () => {
        this.handleMouseLeave(overlay, meta);
      });

      // Alt+Click = deliberate PINNED reveal toggle: the value stays
      // visible after the mouse leaves until Alt+Click again or Esc -
      // useful for demos and keyboard-only users. Locked out in PM.
      overlay.addEventListener('click', (e) => {
        if (e.altKey && !this.presentMode) {
          e.preventDefault();
          e.stopPropagation();
          if (this.isPinned(overlay)) {
            this.unpin(overlay);
            this.reblur(overlay);
          } else if (this.isRevealed(overlay)) {
            // Transient hover reveal -> upgrade to pinned
            this.pin(overlay);
          } else {
            this.disarmReveal(overlay);
            this.executeReveal(overlay);
            this.pin(overlay);
          }
          return;
        }
        // Normal click: the chip is a visual mask, not a button. Forward
        // the click to whatever is underneath (email links, buttons,
        // fields) so redacted UI stays usable.
        if (!e.altKey) this.forwardPointer(overlay, e, 'click');
      });

      overlay.addEventListener('dblclick', (e) => {
        if (!e.altKey) this.forwardPointer(overlay, e, 'dblclick');
      });
    }

    /**
     * Retarget a pointer event to the element actually under the chip.
     * Disables hit-testing on every overlay layer, asks the browser what
     * is really at the point, then replays a synthetic event there.
     * Focusable targets also get .focus() so click-to-edit works.
     */
    forwardPointer(overlay, e, type) {
      const om = this.overlayManager;
      if (!om || !om.withHitTestDisabled) return;
      let target = null;
      try {
        target = om.withHitTestDisabled(() =>
          document.elementFromPoint(e.clientX, e.clientY));
      } catch (err) {}
      if (!target || (om.isOwnElement && om.isOwnElement(target))) return;

      try {
        target.dispatchEvent(new MouseEvent(type, {
          bubbles: true, cancelable: true, view: window,
          clientX: e.clientX, clientY: e.clientY,
          screenX: e.screenX, screenY: e.screenY,
          button: e.button, detail: e.detail || 1,
          ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, metaKey: e.metaKey
        }));
        const tag = target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' ||
            target.isContentEditable) {
          try { target.focus(); } catch (err) {}
        }
      } catch (err) {}
    }

    handleMouseEnter(overlay, meta) {
      if (this.presentMode) return;

      this.activeHoverOverlay = overlay;
      const tooltip = overlay.querySelector('.sps-tooltip');

      if (this.requireAltKey && !this.isAltPressed) {
        if (tooltip) tooltip.classList.add('sps-visible');
        return;
      }

      if (tooltip) tooltip.classList.remove('sps-visible');
      // Already revealed (hover or pinned): re-arming would fire a
      // duplicate REVEAL audit and churn the masks for nothing.
      if (!this.isRevealed(overlay)) this.armReveal(overlay);
    }

    armReveal(overlay) {
      if (this.presentMode) return;
      this.forEachOverlayEl(overlay, el => el.classList.add('sps-arming'));
      const shimmer = overlay.querySelector('.sps-shimmer');
      if (shimmer) {
        shimmer.style.transitionDuration = `${this.revealDelayMs}ms`;
      }

      this.clearHoverTimer();
      this.activeHoverTimer = setTimeout(() => {
        this.executeReveal(overlay);
      }, this.revealDelayMs);
    }

    disarmReveal(overlay) {
      this.clearHoverTimer();
      this.forEachOverlayEl(overlay, el => el.classList.remove('sps-arming'));
      const shimmer = overlay.querySelector('.sps-shimmer');
      if (shimmer) {
        shimmer.style.transitionDuration = '0s';
      }
    }

    executeReveal(overlay) {
      if (this.presentMode) return;
      if (this.isRevealed(overlay)) return; // no duplicate reveal audits
      this.forEachOverlayEl(overlay, el => {
        el.classList.remove('sps-arming');
        el.classList.add('sps-revealed');
      });
      // Punch this record's rect out of the shared blur mask
      if (this.overlayManager && this.overlayManager.refreshMasks) {
        this.overlayManager.refreshMasks();
      }

      const meta = overlay.__spsMeta || {};
      this.onReveal({
        id: meta.id,
        category: meta.category,
        ruleId: meta.ruleId,
        nodeHash: meta.nodeHash,
        url: window.location.href,
        timestamp: Date.now()
      });
    }

    reblur(overlay) {
      const wasRevealed = overlay.classList.contains('sps-revealed') ||
        (overlay.__spsGroup || []).some(el => el.classList.contains('sps-revealed'));
      this.forEachOverlayEl(overlay, el => {
        el.classList.remove('sps-revealed');
        el.classList.remove('sps-arming');
      });
      if (this.overlayManager && this.overlayManager.refreshMasks) {
        this.overlayManager.refreshMasks();
      }

      if (wasRevealed) {
        const meta = overlay.__spsMeta || {};
        this.onReblur({
          id: meta.id,
          category: meta.category,
          ruleId: meta.ruleId,
          timestamp: Date.now()
        });
      }
    }

    handleMouseLeave(overlay, meta) {
      this.disarmReveal(overlay);
      // Pinned (Alt+Click) reveals intentionally survive mouseout.
      if (!this.isPinned(overlay)) this.reblur(overlay);

      const tooltip = overlay.querySelector('.sps-tooltip');
      if (tooltip) tooltip.classList.remove('sps-visible');

      if (this.activeHoverOverlay === overlay ||
          (overlay.__spsGroup || []).includes(this.activeHoverOverlay)) {
        this.activeHoverOverlay = null;
      }
    }

    clearHoverTimer() {
      if (this.activeHoverTimer) {
        clearTimeout(this.activeHoverTimer);
        this.activeHoverTimer = null;
      }
    }
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { HoverController };
  } else {
    global.ScreenShieldHoverController = HoverController;
  }
})(typeof window !== 'undefined' ? window : globalThis);
