'use strict';

// Configuring the Messages module
angular.module('messages').run(['Menus',
	function(Menus) {
		// Set top bar menu items
		Menus.addMenuItem('topbar', 'Messages', 'messages', 'messages');
	}
]);