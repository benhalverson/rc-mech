import { BreakpointObserver } from '@angular/cdk/layout';
import { inject, Service } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { distinctUntilChanged, map } from 'rxjs';

const mobileWorkspaceQuery = '(max-width: 1023px)';

@Service()
export class ResponsiveViewport {
	private readonly breakpointObserver = inject(BreakpointObserver);
	readonly mobile = toSignal(
		this.breakpointObserver.observe(mobileWorkspaceQuery).pipe(
			map(({ matches }) => matches),
			distinctUntilChanged(),
		),
		{ initialValue: false },
	);
}
