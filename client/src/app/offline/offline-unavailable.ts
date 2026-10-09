import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';

/**
 * Renders the guarded destination for an unsupported offline route. Gives the
 * User a route back to prepared Garage work without attempting the missing
 * workflow or altering retained commands.
 */
@Component({
	selector: 'app-offline-unavailable',
	imports: [RouterLink],
	templateUrl: './offline-unavailable.html',
})
export class OfflineUnavailable {}
