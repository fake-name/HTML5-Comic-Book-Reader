/* exported ComicBook */


var ComicBook = (function ($) {

	'use strict';

	/**
	 * Merge two arrays. Any properties in b will replace the same properties in
	 * a. New properties from b will be added to a.
	 *
	 * @param a {Object}
	 * @param b {Object}
	 */
	function merge(a, b) {

		var prop;

		if (typeof b === 'undefined') { b = {}; }

		for (prop in a) {
			if (a.hasOwnProperty(prop)) {
				if (prop in b) { continue; }
				b[prop] = a[prop];
			}
		}

		return b;
	}

	/**
	 * Exception class. Always throw an instance of this when throwing exceptions.
	 *
	 * @param {String} type
	 * @param {Object} object
	 * @returns {ComicBookException}
	 */
	var ComicBookException = {
		INVALID_ACTION: 'invalid action',
		INVALID_PAGE: 'invalid page',
		INVALID_PAGE_TYPE: 'invalid page type',
		UNDEFINED_CONTROL: 'undefined control',
		INVALID_ZOOM_MODE: 'invalid zoom mode',
		INVALID_NAVIGATION_EVENT: 'invalid navigation event'
	};

	function ComicBook(id, srcs, opts) {

		var self = this;
		var canvas_container_id = id;   // canvas element id
		this.srcs = srcs; // array of image srcs for pages

		var defaults = {
			zoomMode: 'smart', // manual / originalSize / fitWidth / fitWindow
			manga: false,     // true / false
			enhance: {},
			keyboard: {
				// next: 78,
				next: 39,
				// previous: 80,
				previous: 37,
				toggleLayout: 76,
				thumbnails: 84
			},
			libPath: '/comicbook/js/',
			forward_buffer: 3,
			fileName: null
		};

		// Possible zoom modes that are cycled through when you hit the cycle-zoom-mode button
		// TODO: Add "smart" zoom mode that looks at aspect ratio and reading direction, to make two-page splits display in a sane matter.
		var zoomModes = ['smart', 'originalSize', 'fitWindow'];
		// 'manual' is disabled because you enter it by clicking the zoom buttons, 'fitWidth' is disabled because I never use it.

		this.showUi = false;
		this.isMobile = false;

		// mobile enhancements
		if (/Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile/i.test(navigator.userAgent)) {

			this.isMobile = true;
			document.body.classList.add('mobile');



			window.addEventListener('load', function () {
				setTimeout(function () {
					window.scrollTo(0, 1);
				}, 0);
			});
		}

		var options = merge(defaults, opts); // options array for internal use

		console.log('Passed opts =', opts);
		console.log('Overall Options =', options);

		var no_pages = srcs.length;
		var pages = [];                 // array of preloaded Image objects
		var canvas_container;           // the HTML5 canvas container object
		var canvases = [];              // the HTML5 canvas objects
		var loaded = [];                // the images that have been loaded so far
		var scale = 1;                  // page zoom scale, 1 = 100%
		var is_double_page_spread = false;
		var controlsRendered = false;   // have the user controls been inserted into the dom yet?
		var page_requested = false;     // used to request non preloaded pages
		var shiv = false;

		var smartActualSize = false;    // Once the smart-sizer has triggered into actual-size mode, it need to be sticky.

		/**
		 * Gets the window.innerWidth - scrollbars
		 */
		function windowWidth() {

			var height = window.innerHeight + 1;

			if (shiv === false) {
				shiv = $(document.createElement('div'))
					.attr('id', 'cb-width-shiv')
					.css({
						width: '100%',
						position: 'absolute',
						top: 0,
						zIndex: '-1000'
					});

				$('body').append(shiv);
			}

			shiv.height(height);

			return shiv.innerWidth();
		}

		// the current page
		var pointer = 0;

		/**
		 * Setup the canvas element for use throughout the class.
		 *
		 * @see #ComicBook.prototype.draw
		 * @see #ComicBook.prototype.enhance
		 */
		function init() {

			// setup canvas
			canvas_container = $(document.getElementById(canvas_container_id));

			// render user controls
			if (controlsRendered === false) {
				self.renderControls();
				controlsRendered = true;
			}

			// add page controls
			window.addEventListener('keydown', self.navigation, false);

		}

		window.addEventListener('touchstart', function (e) {
			var $el = $(e.target);
			if ($el.attr('id') === 'comic') {
				self.toggleUIOverlay();
			}
			if ($el.data('toggle') === 'dropdown' ) {
				$el.siblings('.dropdown').toggle();
			}
		}, false);

		/**
		 * Render Handlebars templates. Templates with data-trigger & data-action will
		 * have the specified events bound.
		 */
		ComicBook.prototype.renderControls = function () {

			var controls = {}, $toolbar;

			$.each(Handlebars.templates, function (name, template) {

				var $template = $(template().trim());
				controls[name] = $template;

				// add event listeners to controls that specify callbacks
				$template.find('*').andSelf().filter('[data-action][data-trigger]').each(function () {

					var $this = $(this);
					var trigger = $this.data('trigger');
					var action = $this.data('action');

					// trigger a direct method if exists
					if (typeof self[$this.data('action')] === 'function') {
						$this.on(trigger, self[action]);
					}

					// throw an event to be caught outside if the app code
					$this.on(trigger, function (e) {
						$(self).trigger(trigger, e);
					});
				});

				$(canvas_container).before($template);
			});

			this.controls = controls;

			$toolbar = this.getControl('toolbar');
			$toolbar
				.find('.manga-' + options.manga).show().end()
				.find('.manga-' + !options.manga).hide().end()
				.find('.layout').hide().end();

		};

		ComicBook.prototype.getControl = function (control) {
			if (typeof this.controls[control] !== 'object') {
				throw ComicBookException.UNDEFINED_CONTROL + ' ' + control;
			}
			return this.controls[control];
		};

		ComicBook.prototype.showControl = function (control) {
			this.getControl(control).show().addClass('open');
		};

		ComicBook.prototype.hideControl = function (control) {
			this.getControl(control).removeClass('open').hide();
		};

		ComicBook.prototype.hideToolBar = function () {
			this.getControl('toolbar').toggle(false);
			$('#cb-status-right').hide();
			$('#cb-status-left').hide();

		};

		ComicBook.prototype.toggleControl = function (control) {

			this.getControl(control).toggle().toggleClass('open');

		};

		ComicBook.prototype.toggleLayout = function() {

			var $toolbar = self.getControl('toolbar');

			$toolbar.find('.layout').hide().end();

			self.drawPage();
		};

		/**
		 * Get the image for a given page.
		 *
		 * @return Image
		 */
		ComicBook.prototype.getPage = function (i)
		{

			if (i < 0 || i > srcs.length-1) {
				throw ComicBookException.INVALID_PAGE + ' ' + i;
			}

			if (typeof pages[i] === 'object') {
				return pages[i];
			} else {
				page_requested = i;
				this.showControl('loadingOverlay');
			}
		};

		/**
		 * @see #preload
		 */
		ComicBook.prototype.draw = function () {

			init();
			// resize navigation controls
			// $('.navigate').outerHeight(window.innerHeight);
			$('#cb-loading-overlay').outerWidth(windowWidth()).height(window.innerHeight);

			// preload images if needed
			if (pages.length !== no_pages) {
				this.preload();
			} else {
				this.drawPage();
				this.updateInfoPanel();
			}
		};

		/**
		 * Zoom the canvas
		 *
		 * @param new_scale {Number} Scale the canvas to this ratio
		 */
		ComicBook.prototype.zoom = function (new_scale) {
			options.zoomMode = 'manual';
			scale = new_scale;
			if (typeof this.getPage(pointer) === 'object')
			{
				this.drawPage();
			}
		};

		ComicBook.prototype.zoomIn = function () {
			self.zoom(scale + 0.1);
		};

		ComicBook.prototype.zoomOut = function () {
			self.zoom(scale - 0.1);
		};

		ComicBook.prototype.fitWidth = function () {
			options.zoomMode = 'fitWidth';
			self.drawPage();
		};

		ComicBook.prototype.originalSize = function () {
			options.zoomMode = 'originalSize';
			self.drawPage();
		};

		ComicBook.prototype.fitWindow = function () {
			options.zoomMode = 'fitWindow';
			self.drawPage();
		};
		ComicBook.prototype.thumbs = function () {
			self.toggleThumbnails();
		};

		/**
		 * Preload all images, draw the page only after a given number have been loaded.
		 *
		 * @see #drawPage
		 */
		ComicBook.prototype.preload = function () {

			var i = pointer; // the current page counter for this method
			var rendered = false;
			var queue = [];

			this.showControl('loadingOverlay');

			function loadImage(i) {

				var page = new Image();
				page.src = srcs[i];

				page.onload = function () {

					pages[i] = this;
					loaded.push(i);

					// There is a  wierd bug here where loaded has two "0" elements at the beginning of the array,
					// leading to loaded.length being one too large. If I block insertion of duplicate elements,
					// nothing ever loads, so fukkit, just subtracting one for the moment.

					$('#cb-progress-bar .progressbar-value').css('width', Math.floor(((loaded.length-1) / no_pages) * 100) + '%');
					$('.progressbar-text').text('Loaded ' + String(loaded.length-1) + ' of ' + String(no_pages));


					// start rendering the comic when the requested page is ready
					if ((rendered === false && ($.inArray(pointer, loaded) !== -1) ||
							(typeof page_requested === 'number' && $.inArray(page_requested, loaded) !== -1))
					) {
						// if the user is waiting for a page to be loaded, render that one instead of the default pointer
						if (typeof page_requested === 'number') {
							pointer = page_requested-1;
							page_requested = false;
						}

						self.drawPage();
						self.hideControl('loadingOverlay');
						rendered = true;
					}

					if (queue.length) {
						loadImage(queue[0]);
						queue.splice(0,1);
					} else {
						$('#cb-status-right').delay(500).fadeOut();
						$('#cb-status-left').delay(500).fadeOut();
					}


				};

			}

			// loads pages in both directions so you don't have to wait for all pages
			// to be loaded before you can scroll backwards
			function preload(start, stop) {

				var j = 0;
				var count = 1;
				var forward = start;
				var backward = start-1;

				while (forward <= stop) {

					if (count > options.forward_buffer && backward > -1) {
						queue.push(backward);
						backward--;
						count = 0;
					} else {
						queue.push(forward);
						forward++;
					}
					count++;
				}

				while (backward > -1) {
					queue.push(backward);
					backward--;
				}

				loadImage(queue[j]);
			}

			preload(i, srcs.length-1);
		};

		ComicBook.prototype.updateInfoPanel = function ()
		{
			var bubbleText = '';
			if (options.fileName)
			{
				bubbleText += 'File: ' + options.fileName + '<br>';
			}

			// ['smart', 'originalSize', 'fitWindow'];
			if (options.zoomMode === 'smart')
			{
				bubbleText += 'Zoom Mode: Smart<br>';
			}
			else if (options.zoomMode === 'originalSize')
			{
				bubbleText += 'Zoom Mode: Original Size<br>';
			}
			else if (options.zoomMode === 'fitWindow')
			{
				bubbleText += 'Zoom Mode: Fit Window<br>';
			}
			else if (options.zoomMode === 'manual')
			{
				bubbleText += 'Zoom Mode: Manual<br>';
			}
			else
			{
				bubbleText += 'Zoom Mode: Unknown?<br>';
			}

			var page = self.getPage(pointer);
			if (page)
			{
				bubbleText += 'Image Size: ' + page.width + 'x' + page.height + '<br>';
			}
			else
			{
				bubbleText += 'Images loading!<br>';
			}

			$('.info-text').html(bubbleText);

		};


		ComicBook.prototype.pageLoaded = function (page_no) {

			return (typeof loaded[page_no-1] !== 'undefined');
		};

		/**
		 * Draw the current page in the canvas
		 */
		ComicBook.prototype.drawPage = function(page_no, reset_scroll) {

			var scrollY;

			reset_scroll = (typeof reset_scroll !== 'undefined') ? reset_scroll : true;
			scrollY = reset_scroll ? 0 : window.scrollY;

			// if a specific page is given try to render it, if not bail and wait for preload() to render it
			if (typeof page_no === 'number' && page_no < srcs.length && page_no > 0) {
				pointer = page_no-1;
				if (!this.pageLoaded(page_no)) {
					this.showControl('loadingOverlay');
					return;
				}
			}

			if (pointer < 0) { pointer = 0; }

			var zoom_scale;
			var offsetW = 0;

			var page = self.getPage(pointer);
			var page2 = false;

			if (typeof page !== 'object') {
				throw ComicBookException.INVALID_PAGE_TYPE + ' ' + typeof page;
			}

			var width = page.width, height = page.height;

			var width_scale;
			var windowHeight;
			var height_scale;


			// update the page scale if a non manual mode has been chosen
			switch (options.zoomMode) {

			case 'manual':
				document.body.style.overflowX = 'auto';
				zoom_scale = scale;
				break;

			case 'fitWidth':
				document.body.style.overflowX = 'hidden';

				// scale up if the window is wider than the page, scale down if the window
				// is narrower than the page
				zoom_scale = (windowWidth() > width) ? ((windowWidth() - width) / windowWidth()) + 1 : windowWidth() / width;

				// update the interal scale var so switching zoomModes while zooming will be smooth
				scale = zoom_scale;
				break;

			case 'originalSize':
				document.body.style.overflowX = 'auto';
				zoom_scale = 1;
				scale = zoom_scale;
				break;

			case 'fitWindow':
				document.body.style.overflowX = 'hidden';

				width_scale = (windowWidth() > width) ?
					((windowWidth() - width) / windowWidth()) + 1 // scale up if the window is wider than the page
					: windowWidth() / width; // scale down if the window is narrower than the page
				windowHeight = window.innerHeight;
				height_scale = (windowHeight > height) ?
					((windowHeight - height) / windowHeight) + 1 // scale up if the window is wider than the page
					: windowHeight / height; // scale down if the window is narrower than the page

				zoom_scale = (width_scale > height_scale) ? height_scale : width_scale;
				scale = zoom_scale;
				break;


			case 'smart':

				// Fit to window if page has an aspect ratio smaller then 2.5.
				// Otherwise, show original size.

				if ((height / width) > 2.5 )
				{
					smartActualSize = true;
				}
				if (smartActualSize)
				{
					document.body.style.overflowX = 'auto';
					zoom_scale = 1;
					scale = zoom_scale;
				}
				else
				{
					document.body.style.overflowX = 'hidden';

					width_scale = (windowWidth() > width) ?
						((windowWidth() - width) / windowWidth()) + 1 // scale up if the window is wider than the page
						: windowWidth() / width; // scale down if the window is narrower than the page
					windowHeight = window.innerHeight;
					height_scale = (windowHeight > height) ?
						((windowHeight - height) / windowHeight) + 1 // scale up if the window is wider than the page
						: windowHeight / height; // scale down if the window is narrower than the page

					zoom_scale = (width_scale > height_scale) ? height_scale : width_scale;
					scale = zoom_scale;
				}
				break;

			default:
				throw ComicBookException.INVALID_ZOOM_MODE + ' ' + options.zoomMode;
			}


			var canvas_width  = page.width * zoom_scale;
			var canvas_height = page.height * zoom_scale;

			var page_width = (options.zoomMode === 'manual') ? page.width * scale : canvas_width;
			var page_height = (options.zoomMode === 'manual') ? page.height * scale : canvas_height;

			canvas_height = page_height;


			// always keep pages centered
			if (canvas_width < windowWidth()) {
				offsetW = (windowWidth() - page_width) / 2;
			}

			// draw the page(s)
			this.drawImageToCanvasArray(page, offsetW, page_width, page_height);

			var current_page = pointer + 1;

			this.getControl('toolbar')
				.find('#current-page').text(current_page)
				.end()
				.find('#page-count').text(srcs.length);



			// disable the fit width button if needed
			$('button.cb-fit-width').attr('disabled', (options.zoomMode === 'fitWidth'));
			$('button.cb-fit-window').attr('disabled', (options.zoomMode === 'fitWindow'));

			// disable prev/next buttons if not needed
			$('.navigate').show();
			if (pointer === 0) {
				if (options.manga) {
					$('.navigate-left').show();
					$('.navigate-right').hide();
				} else {
					$('.navigate-left').hide();
					$('.navigate-right').show();
				}
			}

			if (pointer === srcs.length-1 || (typeof page2 === 'object' && pointer === srcs.length-2)) {
				if (options.manga) {
					$('.navigate-left').hide();
					$('.navigate-right').show();
				} else {
					$('.navigate-left').show();
					$('.navigate-right').hide();
				}
			}

			this.updateInfoPanel();

		};



		ComicBook.prototype.drawImageToCanvasArray = function (image, offsetW, page_width, page_height) {

			var maxDrawHeight = 1500;
			var runningHeight = page_height;
			var xOffset = 0;
			var chunkHeight = 0;


			// Clear out the old canvases and remove them
			while (canvases.length)
			{
				canvases.pop().remove();
			}
			// And the assorted <br> tags as well
			canvas_container.children().each(function(){$(this).remove();});

			var devicePixelRatio = window.devicePixelRatio || 1;

			console.log('Pixel ratio', devicePixelRatio);

			for (var x = 0; x * maxDrawHeight < page_height; x += 1)
			{
				var newCanvas = $('<canvas/>');
				canvas_container.append(newCanvas);
				canvas_container.append($('<br/>'));
				canvases.push(newCanvas);

				var currentCanvas = newCanvas[0];

				// make sure the canvas is always at least full screen, even if the page is more narrow than the screen
				if (page_width > windowWidth())
				{
					currentCanvas.style.width = page_width + 'px';
					currentCanvas.width = page_width * devicePixelRatio;
					// currentCanvas.prop({width: page_width+'px'});
				}
				else
				{
					currentCanvas.style.width = windowWidth() + 'px';
					currentCanvas.width = windowWidth() * devicePixelRatio;
					// currentCanvas.prop({width: page_width+'px'});
				}


				// Draw canvas chunks
				if (runningHeight > maxDrawHeight)
				{
					// TODO: Clean up this mess at some point
					currentCanvas.style.height = maxDrawHeight + 'px';
					currentCanvas.height = maxDrawHeight * devicePixelRatio;
					chunkHeight    = maxDrawHeight;                 // Height of the current canvas chunk
					xOffset       += maxDrawHeight;                 // Current draw x-offset
					runningHeight -= maxDrawHeight;                 // Remaining image height to draw
				}
				else
				{
					currentCanvas.style.height = runningHeight + 'px';
					currentCanvas.height = runningHeight * devicePixelRatio;
					chunkHeight    = runningHeight;
					xOffset       += runningHeight;
					runningHeight -= runningHeight;
				}

				var context = currentCanvas.getContext('2d');

				var imXPos = offsetW;
				var imYPos = (chunkHeight - xOffset) * devicePixelRatio;
				var imXSz  = page_width  * devicePixelRatio;
				var imYSz  = page_height * devicePixelRatio;

				context.drawImage(image, imXPos, imYPos, imXSz, imYSz);
			}

		};


		/**
		 * Increment the counter and draw the page in the canvas
		 *
		 * @see #drawPage
		 */
		ComicBook.prototype.drawNextPage = function () {

			var page;

			try {
				page = self.getPage(pointer+1);
			} catch (e) {}

			if (!page) { return false; }

			if (pointer + 1 < pages.length) {
				pointer += 1;
				try {
					self.drawPage();
				} catch (e) {}
			}

			// make sure the top of the page is in view
			window.scroll(0, 0);
		};

		/**
		 * Decrement the counter and draw the page in the canvas
		 *
		 * @see #drawPage
		 */
		ComicBook.prototype.drawPrevPage = function () {

			var page;

			try {
				page = self.getPage(pointer-1);
			} catch (e) {}

			if (!page) { return false; }

			is_double_page_spread = (page.width > page.height); // need to run double page check again here as we are going backwards

			if (pointer > 0) {
				pointer -= 1;
				self.drawPage();
			}

			// make sure the top of the page is in view
			window.scroll(0, 0);
		};


		ComicBook.prototype.navigation = function (e) {

			// disable navigation when the overlay is showing
			if ($('#cb-loading-overlay').is(':visible')) { return false; }

			var side = false;

			switch (e.type)
			{

			case 'click':
				side = e.currentTarget.getAttribute('data-navigate-side');
				break;

			case 'keydown':

				// navigation
				if (e.keyCode === options.keyboard.previous)
				{
					side = 'left';
				}
				if (e.keyCode === options.keyboard.next)
				{
					side = 'right';
				}

				// display controls
				if (e.keyCode === options.keyboard.toolbar) {
					self.toggleUIOverlay();
				}
				if (e.keyCode === options.keyboard.toggleLayout) {
					self.toggleLayout();
				}

				// display thumbnail browser
				if (e.keyCode === options.keyboard.thumbnails) {
					self.toggleThumbnails();
				}
				break;

			default:
				throw ComicBookException.INVALID_NAVIGATION_EVENT + ' ' + e.type;
			}


			if (side)
			{



				e.preventDefault();
				e.stopPropagation();

				if (side === 'center')
				{
					console.log('Center clicked? Toggling toolbar');
					self.toggleUIOverlay();
				}
				else if (side === 'bottom')
				{
					// TODO: Add a nice pop-up label for the current zoom-mode.
					var curModeIndice = zoomModes.indexOf(options.zoomMode);
					curModeIndice = (curModeIndice + 1) % zoomModes.length;
					options.zoomMode = zoomModes[curModeIndice];
					console.log('Zoom Mode!', options.zoomMode);
					self.drawPage();
					$('#cb-status-left').show().delay(1000).fadeOut();
				}
				else
				{

					console.log('Page change event!');
					// western style (left to right)
					if (!options.manga) {
						if (side === 'left')
						{
							self.drawPrevPage();
						}
						if (side === 'right')
						{
							self.drawNextPage();
						}
					}
					// manga style (right to left)
					else {
						if (side === 'left') { self.drawNextPage(); }
						if (side === 'right') { self.drawPrevPage(); }
					}


					// Close any open toolbars
					self.hideToolBar();
				}

				self.updateInfoPanel();
				return false;
			}
		};

		ComicBook.prototype.toggleReadingMode = function () {
			options.manga = !options.manga;
			self.getControl('toolbar')
				.find('.manga-' + options.manga).show().end()
				.find('.manga-' + !options.manga).hide();
			self.drawPage();
		};

		ComicBook.prototype.toggleThumbnails = function () {
			// TODO: show page numbers
			// TODO: in double page mode merge both pages into a single link
			// TODO: only load thumbnails when they are in view
			// TODO: keyboard navigation (left / right / up / down / enter)
			// TODO: highlight currently selected thumbnail
			// TODO: focus on current page
			// TODO: toolbar button
			var $thumbnails = self.getControl('thumbnails');
			$thumbnails.html('');
			self.toggleControl('thumbnails');
			$.each(pages, function (i, img) {
				var $img = $(img).clone();
				var $link = $('<a>').attr('href', '#' + i).append($img);
				$link.on('click', function () {
					self.hideControl('thumbnails');
				});
				$thumbnails.append($link);
			});
		};

		ComicBook.prototype.toggleUIOverlay = function () {
			self.toggleControl('toolbar');
			var toolbar = self.getControl('toolbar');
			if(toolbar.is(':visible'))
			{
				$('#cb-status-right').show();
				$('#cb-status-left').show();
			}
			else

			{
				$('#cb-status-right').hide();
				$('#cb-status-left').hide();
			}

		};

		ComicBook.prototype.destroy = function () {

			$.each(this.controls, function (name, $control) {
				$control.remove();
			});

			$.each(canvases, function (name, $canvasItem) {

				$canvasItem.width = 0;
				$canvasItem.height = 0;

			});

			window.removeEventListener('keydown', this.navigation, false);


			// $(this).trigger('destroy');
		};

	}

	return ComicBook;

})(jQuery);
