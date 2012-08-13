/*global global, log */ // <-- jshint
/* Workspaces Grid GNOME shell extension.
 *
 * mathematical.coffee <mathematical.coffee@gmail.com>
 *
 * Inspired by Frippery Static Workspaces[0] by R. M. Yorston
 *
 * [0]: https://extensions.gnome.org/extension/12/static-workspaces/
 *
 * ----------------------------------------------------
 * Notes for other developers
 * --------------------------
 * If you wish to see if your extension is compatible with this, note:
 *
 * This extension exports a number of constants and functions to an object
 * global.screen.workspace_grid for your convenience. Note that this extension
 * must be enabled for this all to work. global.screen.workspace_grid contains:
 *
 *   (Exported Constants)
 *   - Directions = { UP, LEFT, RIGHT, DOWN } : directions for navigating (see
 *                                              moveWorkspaces further down)
 *   - rows     : number of rows of workspaces
 *   - columns  : number of columns of workspaces
 *
 *   (Exported Functions)
 *   - moveWorkspace : switches workspaces in the direction specified, being
 *                     either UP, LEFT, RIGHT or DOWN (see Directions).
 *   - rowColToIndex : converts the row/column into an index for use with (e.g.)
 *                     global.screen.get_workspace_by_index(i)
 *   - indexToRowCol : converts an index (0 to global.screen.n_workspaces-1) to
 *                     a row and column
 *
 * For example, to move to the workspace below us:
 *     const WorkspaceGrid = global.screen.workspace_grid;
 *     WorkspaceGrid.moveWorkspace(WorkspaceGrid.Directions.DOWN);
 *
 * I am happy to try help/give an opinion/improve this extension to try make it
 *  more compatible with yours, email me :)
 *
 * Listening to workspace_grid
 * ---------------------------
 * Say you want to know the number of rows/columns of workspaces in your
 * extension. Then you have to wait for this extension to load and populate
 * global.screen.workspace_grid.
 *
 * For the moment you will just have to delay your extension's 'enable' function
 * until this one has loaded first. Adding in a Mainloop.idle_add should do the
 * trick.
 *
 * What I'd *like* to do is provide a signal `workspace-grid-enabled` on 
 * global.screen when this extension is done populating
 * global.screen.workspace_grid, and your extension can connect to that, e.g.:
 *
 *     global.screen.connect('workspace-grid-enabled', function () {
 *         // now you can use global.screen.workspace_grid.rows etc
 *     });
 *
 * (NOTE: is it preferred that you just listen to 'extension-enabled' on this
 *  extension's UUID?)
 *
 * Further notes
 * -------------
 * Workspaces can be changed by the user by a number of ways, and this extension
 * aims to cover them all:
 * - keybinding (wm.setKeybindingHandler)
 * - keybinding with global grab in progress (e.g. in Overview/lg): see
 *    Main._globalKeyPressHandler
 * - scrolling in the overview (WorkspacesView.WorkspacesDisplay._onScrollEvent)
 * - clicking in the overview.
 *
 * Dev notes for this extension
 * ----------------------------
 * From GNOME 3.4+ to keep workspaces static we can just do:
 * - org.gnome.shell.overrides.dynamic-workspaces false
 * - org.gnome.desktop.wm.preferences.num-workspaces <numworkspaces>
 * (TODO: report of this losing the ability to drag n drop applications between
 * workspaces - check).
 *
 * See also the edited workspaces indicator
 * http://kubiznak-petr.ic.cz/en/workspace-indicator.php (this is column-major).
 *
 * TODO
 * ----
 * - workspace indicator (which you can toggle on/off) [perhaps separate ext.]
 *   - r-click to rename workspace (meta.prefs_change_workspace_name)
 *   - r-click to adjust rows/cols
 *   - see gnome-panel. (Click to drag ....)
 *   - also workspaceThumbnail ThumbnailsBox shows each window in each workspace
 *     preview - we just want a simplified version of that. (addThumbnails)
 * - ** when it gets too wide collapse it, and make sure it doesn't overflow!
 *
 * GNOME 3.2 <-> GNOME 3.4
 * -----------------------
 * - Main.wm.setKeybindingHandler -> Meta.keybindings_set_custom_handler
 * - keybinding names '_' -> '-'
 * - keybinding callback: wm, binding, mask, window, backwards ->
 *    display, screen, window, binding
 * - keybinding callback: binding -> binding.get_name()
 *
 */

//// CONFIGURE HERE (note: you can have at most 36 workspaces)
const WORKSPACE_CONFIGURATION = {
    rows: 2,
    columns: 3
};

const Clutter = imports.gi.Clutter;
const Lang = imports.lang;
const Mainloop = imports.mainloop;
const Meta = imports.gi.Meta;
const Shell = imports.gi.Shell;
const St = imports.gi.St;

const IconGrid = imports.ui.iconGrid;
const Main = imports.ui.main;
const Tweener = imports.ui.tweener;
const WorkspaceSwitcher = imports.ui.workspaceSwitcherPopup;
const WorkspaceThumbnail = imports.ui.workspaceThumbnail;
const WorkspacesView = imports.ui.workspacesView;

/* These double as keybinding names and ways for moveWorkspace to know which
 * direction I want to switch to */
const UP = 'switch_to_workspace_up';
const DOWN = 'switch_to_workspace_down';
const LEFT = 'switch_to_workspace_left';
const RIGHT = 'switch_to_workspace_right';

/* Import some constants from other files and also some laziness */
const MAX_THUMBNAIL_SCALE = WorkspaceThumbnail.MAX_THUMBNAIL_SCALE;
const ThumbnailState = WorkspaceThumbnail.ThumbnailState;
const ThumbnailsBoxProto = WorkspaceThumbnail.ThumbnailsBox.prototype;
const WorkspacesDisplayProto = WorkspacesView.WorkspacesDisplay.prototype;

/* it seems the max number of workspaces is 36
 * (MAX_REASONABLE_WORKSPACES in mutter/src/core/prefs.c)
 */
const MAX_WORKSPACES = 36;

/* storage for the extension */
let staticWorkspaceStorage = {};
let nWorkspaces;
let workspaceSwitcherPopup = null;
let globalKeyPressHandler = null;
let thumbnailBoxStorage = {};

/***************
 * Helper functions
 ***************/
/* Converts an index (from 0 to global.screen.n_workspaces) into [row, column]
 * being the row and column of workspace `index` according to the user's layout.
 *
 * Row and column start from 0.
 */
function indexToRowCol(index) {
    // row-major. 0-based.
    return [Math.floor(index / global.screen.workspace_grid.columns),
       index % global.screen.workspace_grid.columns];
}

/* Converts a row and column (0-based) into the index of that workspace.
 *
 * If the resulting index is greater than MAX_WORKSPACES (the maximum number
 * of workspaces allowable by Mutter), it will return -1.
 */
function rowColToIndex(row, col) {
    // row-major. 0-based.
    let idx = row * global.screen.workspace_grid.columns + col;
    if (idx >= MAX_WORKSPACES) {
        idx = -1;
    }
    return idx;
}

/* Switch to the appropriate workspace.
 * direction is either UP, LEFT, RIGHT or DOWN.
 *
 * This can occur through:
 * - keybinding (wm.setKeybindingHandler)
 * - keybinding with global grab in progress (e.g. Overview/lg)
 * - scrolling/clicking in the overview
 * - (other extensions, e.g. navigate with up/down arrows:
 *        https://extensions.gnome.org/extension/29/workspace-navigator/)
 */
function moveWorkspace(direction) {
    let from = global.screen.get_active_workspace_index(),
        [row, col] = indexToRowCol(from),
        to;

    switch (direction) {
    case LEFT:
        col = Math.max(0, col - 1);
        break;
    case RIGHT:
        col = Math.min(global.screen.workspace_grid.columns - 1, col + 1);
        break;
    case UP:
        row = Math.max(0, row - 1);
        break;
    case DOWN:
        row = Math.min(global.screen.workspace_grid.rows - 1, row + 1);
        break;
    }
    to = rowColToIndex(row, col);
    //log('moving from workspace %d to %d'.format(from, to));
    if (to > 0 && to !== from) {
        global.screen.get_workspace_by_index(to).activate(
                global.get_current_time());
    }

    // show the workspace switcher popup
    if (!Main.overview.visible) {
        workspaceSwitcherPopup.display(direction, to);
    }
}

/************
 * Workspace Switcher that can do rows and columns as opposed to just rows.
 ************/
function WorkspaceSwitcherPopup() {
    this._init(this);
}

WorkspaceSwitcherPopup.prototype = {
    __proto__: WorkspaceSwitcher.WorkspaceSwitcherPopup.prototype,

    _init: function () {
        WorkspaceSwitcher.WorkspaceSwitcherPopup.prototype._init.call(this);
        this._list.destroy();
        this._list = null;
        this._container.style_class = '';

        this._grid = new IconGrid.IconGrid({
            rowLimit: global.screen.workspace_grid.rows,
            columnLimit: global.screen.workspace_grid.columns,
            xAlign: St.Align.MIDDLE
        });
        this._grid.actor.style_class = 'workspace-switcher-grid';

        this._container.add(this._grid.actor, {expand: true});

        this._redraw();
    },

    _redraw: function (direction, activeWorkspaceIndex) {
        if (!this._grid) {
            return;
        }

        // FIXME: don't destroy all the time, only when configuration changes.
        this._grid.removeAll();

        for (let i = 0; i < global.screen.n_workspaces; ++i) {
            let icon = new St.Bin({style_class: 'ws-switcher-box'}),
                primary = Main.layoutManager.primaryMonitor;
            this._grid.addItem(icon);
            icon.width = icon.height * primary.width / primary.height;
        }

        // It seems they also do row-major layout.
        let ch = this._grid.getItemAtIndex(activeWorkspaceIndex),
            style = null;
        switch (direction) {
        case UP:
            style = 'ws-switcher-active-up';
            break;
        case DOWN:
            style = 'ws-switcher-active-down';
            break;
        case RIGHT:
            style = 'ws-switcher-active-right';
            break;
        case LEFT:
            style = 'ws-switcher-active-left';
            break;
        }
        if (style) {
            ch.remove_style_class_name('ws-switcher-box');
            ch.add_style_class_name(style);
        }

        // FIXME: why does this._container not automatically stretch to
        // this._grid's height?
        this._container.height = this._grid._grid.height +
            this._grid.actor.get_theme_node().get_vertical_padding();
    }
};

/* Keybinding handler.
 * Should bring up a workspace switcher.
 */
function showWorkspaceSwitcher(shellwm, binding, mask, window, backwards) {
    if (global.screen.n_workspaces === 1)
        return;

    moveWorkspace(binding);
}

/******************
 * Overrides the 'switch_to_workspace_XXX' keybindings
 ******************/
function overrideKeybindingsAndPopup() {
    Main.wm.setKeybindingHandler(LEFT, showWorkspaceSwitcher);
    Main.wm.setKeybindingHandler(RIGHT, showWorkspaceSwitcher);
    Main.wm.setKeybindingHandler(UP, showWorkspaceSwitcher);
    Main.wm.setKeybindingHandler(DOWN, showWorkspaceSwitcher);

    // make sure our keybindings work when (e.g.) overview is open too.
    globalKeyPressHandler = Main._globalKeyPressHandler;
    Main._globalKeyPressHandler = function (actor, event) {
        /* First let our WORKSPACE_<direction> keybinding handlers override
         * any in _globalKeyPressHandler, then proceed to _globalKeyPressHandler
         */
        if (Main.modalCount === 0 ||
                event.type() !== Clutter.EventType.KEY_PRESS) {
            return false;
        }

        let keyCode = event.get_key_code(),
            modifierState = Shell.get_event_state(event),
            action = global.display.get_keybinding_action(keyCode,
                    modifierState);

        switch (action) {
        case Meta.KeyBindingAction.WORKSPACE_LEFT:
            moveWorkspace(LEFT);
            return true;
        case Meta.KeyBindingAction.WORKSPACE_RIGHT:
            moveWorkspace(RIGHT);
            return true;
        case Meta.KeyBindingAction.WORKSPACE_UP:
            moveWorkspace(UP);
            return true;
        case Meta.KeyBindingAction.WORKSPACE_DOWN:
            moveWorkspace(DOWN);
            return true;
        }
        return globalKeyPressHandler(actor, event);
    };
}

/* Restore the original keybindings */
function unoverrideKeybindingsAndPopup() {
    // Restore t
    Main.wm.setKeybindingHandler(LEFT, Lang.bind(Main.wm,
                Main.wm.prototype._showWorkspaceSwitcher));
    Main.wm.setKeybindingHandler(RIGHT, Lang.bind(Main.wm,
                Main.wm.prototype._showWorkspaceSwitcher));
    Main.wm.setKeybindingHandler(UP, Lang.bind(Main.wm,
                Main.wm.prototype._showWorkspaceSwitcher));
    Main.wm.setKeybindingHandler(DOWN, Lang.bind(Main.wm,
                Main.wm.prototype._showWorkspaceSwitcher));

    Main._globalKeyPressHandler = globalKeyPressHandler;
}

/******************
 * Overrides the workspaces display in the overview
 ******************/
// UPTO
const MAX_SCREEN_HFRACTION = 1;

function ThumbnailsBox() {
    this._init();
}
ThumbnailsBox.prototype = {
    // NOTES ON SIZING
    // ---------------
    // We can use up to the entire height of the screen for vertical positioning
    // We can use up to (???) fraction of the width for horizontal positioning
    // Pick the scale that makes it fit.
    __proto__: ThumbnailsBoxProto,

    /**
     * The following are overridden simply to incorporate ._indicatorX in the
     * same way as ._indicatorY
     **/
    _init: function () {
        ThumbnailsBoxProto._init.apply(this);
        this._indicatorX = 0; // to match indicatorY
    },

    set indicatorX(indicatorX) {
        this._indicatorX = indicatorX;
        //this.actor.queue_relayout(); // <-- we only ever change indicatorX
        // when we change indicatorY and that already causes a queue_relayout
        // so we omit it here so as not to have double the relayout requests..
    },

    get indicatorX() {
        return this._indicatorX;
    },

    _activeWorkspaceChanged: function (wm, from, to, direction) {
        let thumbnail;
        let activeWorkspace = global.screen.get_active_workspace();
        for (let i = 0; i < this._thumbnails.length; i++) {
            if (this._thumbnails[i].metaWorkspace === activeWorkspace) {
                thumbnail = this._thumbnails[i];
                break;
            }
        }

        this._animatingIndicator = true;
        this.indicatorY = this._indicator.allocation.y1;
        this.indicatorX = this._indicator.allocation.x1; // <-- added
        Tweener.addTween(this,
                         { indicatorY: thumbnail.actor.allocation.y1,
                           indicatorX: thumbnail.actor.allocation.x1, // added
                           time: WorkspacesView.WORKSPACE_SWITCH_TIME,
                           transition: 'easeOutQuad',
                           onComplete: function () {
                                this._animatingIndicator = false;
                                this._queueUpdateStates();
                            },
                           onCompleteScope: this
                         });
    },

    /**
     * The following are to get things to layout in a grid
     **/

    // BIG TODO: how to prevent width/height from overflowing the screen?
    // (e.g. try putting 8 columns of workspaces)
    _getPreferredHeight: function (actor, forWidth, alloc) {
        if (this._thumbnails.length === 0) {
            return;
        }
        let themeNode = this._background.get_theme_node(),
            spacing = this.actor.get_theme_node().get_length('spacing'),
            nRows = global.screen.workspace_grid.rows,
            nCols = global.screen.workspace_grid.columns,
            totalSpacingX = (nCols - 1) * spacing,
            totalSpacingY = (nRows - 1) * spacing,
            availX = forWidth - totalSpacingX,
            scale = (availX < 0 ? MAX_THUMBNAIL_SCALE :
                    (availX / nCols) / this._porthole.width);

        // 'scale' is the scale we need to fit `nCols` of workspaces in the
        // available width (after taking into account padding).
        scale = Math.min(scale, MAX_THUMBNAIL_SCALE);

        // natural height is nRows of workspaces + (nRows-1)*spacingY
        [alloc.min_size, alloc.natural_size] =
            themeNode.adjust_preferred_height(
                    totalSpacingY,
                    totalSpacingY + nRows * this._porthole.height * scale
        );
    },

    _getPreferredWidth: function (actor, forHeight, alloc) {
        if (this._thumbnails.length === 0) {
            return;
        }

        let themeNode = this._background.get_theme_node(),
            spacing = this.actor.get_theme_node().get_length('spacing'),
            nRows = global.screen.workspace_grid.rows,
            nCols = global.screen.workspace_grid.columns,
            totalSpacingX = (nCols - 1) * spacing,
            totalSpacingY = (nRows - 1) * spacing,
            availY = forHeight - totalSpacingY,
            //scale = (availY / nRows) / this._porthole.height;
            scale = (availY < 0 ? MAX_THUMBNAIL_SCALE :
                    (availY / nRows) / this._porthole.height);

        // 'scale' is the scale we need to fit `nRows` of workspaces in the
        // available height (after taking into account padding).
        scale = Math.min(scale, MAX_THUMBNAIL_SCALE);

        // natural width is nCols of workspaces + (nCols-1)*spacingX
        [alloc.min_size, alloc.natural_size] =
            themeNode.adjust_preferred_height(
                    totalSpacingX,
                    totalSpacingX + nCols * this._porthole.width * scale
        );
    },

    _allocate: function (actor, box, flags) {
        if (this._thumbnails.length === 0) // not visible
            return;

        let rtl = (Clutter.get_default_text_direction() ===
                Clutter.TextDirection.RTL),
        // See comment about this._background in _init()
            themeNode = this._background.get_theme_node(),
            contentBox = themeNode.get_content_box(box),
            portholeWidth = this._porthole.width,
            portholeHeight = this._porthole.height,
            spacing = this.actor.get_theme_node().get_length('spacing'),
        // Compute the scale we'll need once everything is updated
            nCols = global.screen.workspace_grid.columns,
            nRows = global.screen.workspace_grid.rows,
            totalSpacingY = (nRows - 1) * spacing,
            totalSpacingX = (nCols - 1) * spacing,
            availX = (contentBox.x2 - contentBox.x1) - totalSpacingX,
            availY = (contentBox.y2 - contentBox.y1) - totalSpacingY;

        // TODO: why not .get_preferred_width(box.y2 - box.y1) ??

        // work out what scale we need to squeeze all the rows/cols of
        // workspaces in (TODO: limit to MAX_SCREEN_HFRACTION in width?)
        let newScale = Math.min((availX / nCols) / portholeWidth,
                            (availY / nRows) / portholeHeight,
                            MAX_THUMBNAIL_SCALE);

        if (newScale !== this._targetScale) {
            if (this._targetScale > 0) {
                // We don't do the tween immediately because we need to observe
                // the ordering in queueUpdateStates - if workspaces have been
                // removed we need to slide them out as the first thing.
                this._targetScale = newScale;
                this._pendingScaleUpdate = true;
            } else {
                this._targetScale = this._scale = newScale;
            }

            this._queueUpdateStates();
        }

        let thumbnailHeight = portholeHeight * this._scale,
            thumbnailWidth = portholeWidth * this._scale,
            roundedHScale = Math.round(thumbnailWidth) / portholeWidth,
            roundedVScale = Math.round(thumbnailHeight) / portholeHeight;

        let slideOffset; // X offset when thumbnail is fully slid offscreen
        // (animate sliding that column onto screen)
        if (rtl)
            slideOffset = -thumbnailWidth + themeNode.get_padding(St.Side.LEFT);
        else
            slideOffset = thumbnailWidth + themeNode.get_padding(St.Side.RIGHT);

        let childBox = new Clutter.ActorBox();

        // Don't understand workspaceThumbnail.js here - I just cover the
        // entire allocation?
        this._background.allocate(box, flags);
        // old: box.x1 = box.x1 + (contentBox.x2-contentBox.x1) - thumbnailWid

        let indicatorY = this._indicatorY,
            indicatorX = this._indicatorX;
        // when not animating, the workspace position overrides this._indicatorY
        let indicatorWorkspace = !this._animatingIndicator ?
            global.screen.get_active_workspace() : null;

        // position roughly centred vertically: start at y1 + (backgroundHeight
        //  - thumbnailsHeights)/2
        let y = contentBox.y1 + (availY - (nRows * thumbnailHeight)) / 2,
            x = contentBox.x1,
            i = 0,
            thumbnail;

        for (let row = 0; row < global.screen.workspace_grid.rows; ++row) {
            x = contentBox.x1;
            for (let col = 0; col < global.screen.workspace_grid.columns; ++col) {
                thumbnail = this._thumbnails[i];

                // NOTE: original ThumbnailsBox does a lot of intricate calcul-
                // ations to do with rounding to make sure everything's evenly
                // spaced; we don't bother because I'm not smart enough to work
                // it out (so the spacing on the left might be a few pixels
                // more than that on the right).
                let x1 = x,
                    y1 = y;

                if (thumbnail.slidePosition !== 0) {
                    if (rtl) {
                        x1 -= slideOffset * thumbnail.slidePosition;
                    } else {
                        x1 += slideOffset * thumbnail.slidePosition;
                    }
                }

                if (thumbnail.metaWorkspace === indicatorWorkspace) {
                    indicatorY = y1;
                    indicatorX = x1;
                }

                // Allocating a scaled actor is funny - x1/y1 correspond to the
                // origin of the actor, but x2/y2 are increased by the unscaled
                // size.
                childBox.x1 = x1;
                childBox.x2 = x1 + portholeWidth;
                childBox.y1 = y1;
                childBox.y2 = y1 + portholeHeight;

                thumbnail.actor.set_scale(roundedHScale, roundedVScale);
                thumbnail.actor.allocate(childBox, flags);

                x += thumbnailWidth - thumbnailWidth *
                    thumbnail.collapseFraction;

                // add spacing
                x += spacing - thumbnail.collapseFraction * spacing;

                ++i;
                if (i >= MAX_WORKSPACES) {
                    break;
                }
            }
            y += thumbnailHeight - thumbnailHeight * thumbnail.collapseFraction;
            // add spacing
            y += spacing - thumbnail.collapseFraction * spacing;

            if (i >= MAX_WORKSPACES) {
                break;
            }
        }

        // allocate the indicator (which tells us what is the current workspace)
        childBox.x1 = indicatorX;
        childBox.x2 = indicatorX + thumbnailWidth;
        childBox.y1 = indicatorY;
        childBox.y2 = indicatorY + thumbnailHeight;
        this._indicator.allocate(childBox, flags);
    },

    destroy: function () {
        this.actor.destroy();
    }
};

function overrideWorkspaceDisplay() {
    // FIXME: Why can I not override ThumbnailsBox._init,
    // _getPreferredWidth, _getPreferredHeight or _allocate, but I *can*
    // override (say) show?

    Mainloop.idle_add(function () {
        let wD = Main.overview._workspacesDisplay;

        thumbnailBoxStorage.original = wD._thumbnailsBox;
        thumbnailBoxStorage.new = new ThumbnailsBox();

        wD._controls.remove_actor(wD._thumbnailsBox.actor);
        wD._thumbnailsBox = thumbnailBoxStorage.new;
        wD._controls.add_actor(wD._thumbnailsBox.actor);

        // add the ability to scroll sideways over the thumbnails too
        thumbnailBoxStorage._onScrollEvent =
            WorkspacesDisplayProto._onScrollEvent;
        WorkspacesDisplayProto._onScrollEvent = function (actor, event) {
            switch (event.get_scroll_direction()) {
            case Clutter.ScrollDirection.UP:
                moveWorkspace(UP);
                break;
            case Clutter.ScrollDirection.DOWN:
                moveWorkspace(DOWN);
                break;
            case Clutter.ScrollDirection.LEFT:
                moveWorkspace(LEFT);
                break;
            case Clutter.ScrollDirection.RIGHT:
                moveWorkspace(RIGHT);
                break;
            }
        };
    });
}

function unoverrideWorkspaceDisplay() {
    let wD = Main.overview._workspacesDisplay;

    wD._controls.remove_actor(wD._thumbnailsBox.actor);
    wD._thumbnailsBox.destroy();

    wD._thumbnailsBox = thumbnailBoxStorage.old;
    wD._controls.add_actor(wD._thumbnailsBox.actor);

    thumbnailBoxStorage = {};
}

/******************
 * tells Meta about the number of workspaces we want
 ******************/
function modifyNumWorkspaces() {
    /// Storage
    nWorkspaces = Meta.prefs_get_num_workspaces();

    /// Setting the number of workspaces.
    Meta.prefs_set_num_workspaces(
        global.screen.workspace_grid.rows * global.screen.workspace_grid.columns
    );

    // This appears to do nothing but we'll do it in case it helps.
    global.screen.override_workspace_layout(
        Meta.ScreenCorner.TOPLEFT, // workspace 0
        false, // true == lay out in columns. false == lay out in rows
        global.screen.workspace_grid.rows,
        global.screen.workspace_grid.columns
    );
}

function unmodifyNumWorkspaces() {
    // restore original number of workspaces (though it doesn't really matter)
    Meta.prefs_set_num_workspaces(nWorkspaces);

    global.screen.override_workspace_layout(
        Meta.ScreenCorner.TOPLEFT, // workspace 0
        true, // true == lay out in columns. false == lay out in rows
        nWorkspaces,
        1 // columns
    );
}

/******************
 * This is the stuff from Frippery Static Workspaces
 ******************/
function dummy() {
    return false;
}

// FIXME: check in GNOME 3.4 about just using overrides.dynamic-workspaces.
function makeWorkspacesStatic() {
    /// storage
    staticWorkspaceStorage._nWorkspacesChanged = Main._nWorkspacesChanged;
    staticWorkspaceStorage._queueCheckWorkspaces = Main._queueCheckWorkspaces;
    staticWorkspaceStorage._checkWorkspaces = Main._checkWorkspaces;

    /// patching
    Main._nWorkspacesChanged = dummy;
    Main._queueCheckWorkspaces = dummy;
    Main._checkWorkspaces = dummy;

    Main._workspaces.forEach(function (workspace) {
            workspace.disconnect(workspace._windowAddedId);
            workspace.disconnect(workspace._windowRemovedId);
            workspace._lastRemovedWindow = null;
        });
}

function unmakeWorkspacesStatic() {
    // undo make workspaces static
    Main._nWorkspacesChanged = staticWorkspaceStorage._nWorkspacesChanged;
    Main._queueCheckWorkspaces = staticWorkspaceStorage._queueCheckWorkspaces;
    Main._checkWorkspaces = staticWorkspaceStorage._checkWorkspaces;

    Main._workspaces = [];

    // recalculate new number of workspaces.
    Main._nWorkspacesChanged();
}

/******************
 * Store rows/cols of workspaces, convenience functions to
 * global.screen.workspace_grid
 * such that if other extension authors want to they can use them.
 *
 * (TODO: just use imports.misc.extensionUtils.extensions[uuid].XXXX ?)
 *
 * Exported constants:
 * Directions = { UP, LEFT, RIGHT, DOWN } : directions for navigating workspaces
 * rows     : number of rows of workspaces
 * columns  : number of columns of workspaces
 *
 * Exported functions:
 * rowColToIndex : converts the row/column into an index for use with (e.g.)
 *                 global.screen.get_workspace_by_index(i)
 * indexToRowCol : converts an index (0 to global.screen.n_workspaces-1) to a
 *                 row and column
 * moveWorkspace : switches workspaces in the direction specified, being either
 *                 UP, LEFT, RIGHT or DOWN (see Directions).
 ******************/
function exportFunctionsAndConstants() {
    global.screen.workspace_grid = {
        Directions: {
            UP: UP,
            LEFT: LEFT,
            RIGHT: RIGHT,
            DOWN: DOWN
        },

        rows: WORKSPACE_CONFIGURATION.rows,
        columns: WORKSPACE_CONFIGURATION.columns,

        rowColToIndex: rowColToIndex,
        indexToRowCol: indexToRowCol,
        moveWorkspace: moveWorkspace
    };

    // It seems you can only have 36 workspaces max.
    if (WORKSPACE_CONFIGURATION.rows * WORKSPACE_CONFIGURATION.columns >
            MAX_WORKSPACES) {
        log("WARNING [workspace-grid]: You can have at most 36 workspaces, " +
                "will ignore the rest");
        global.screen.workspace_grid.rows = Math.ceil(
                MAX_WORKSPACES / global.screen.workspace_grid.columns);
    }
    // TODO: how to set this up?
    // global.screen.emit('workspace-grid-enabled');
}

function unexportFunctionsAndConstants() {
    // TODO: how to set this up?
    // global.screen.emit('workspace-grid-disabled');
    delete global.screen.workspace_grid;
}

/***************************
 *         EXTENSION       *
 ***************************/
function init() {
}

function enable() {
    makeWorkspacesStatic();
    exportFunctionsAndConstants(); // so other extension authors can use.
    modifyNumWorkspaces();
    overrideKeybindingsAndPopup();
    overrideWorkspaceDisplay();

    // create a workspace switcher popup (no hurry; wait until there's free
    // CPU)
    Mainloop.idle_add(function () {
        workspaceSwitcherPopup = new WorkspaceSwitcherPopup();
        // FIXME: for some reason the height is off the first time.
        // A quick show/hide will do the trick but surely there's a better way
        // (i.e. a reason why this occurs and I can address that directly)
        workspaceSwitcherPopup.actor.show();
        workspaceSwitcherPopup.actor.hide();
        return false;
    });
}

function disable() {
    unoverrideWorkspaceDisplay();
    unoverrideKeybindingsAndPopup();
    unmodifyNumWorkspaces();
    unexportFunctionsAndConstants();
    unmakeWorkspacesStatic();

    workspaceSwitcherPopup = null;
}