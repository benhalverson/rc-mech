import { Component, inject } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';

@Component({
	selector: 'app-sign-in',
	imports: [RouterLink],
	template: `
		<main class="access-shell">
			<section class="access-card" aria-labelledby="sign-in-title">
				<div class="eyebrow">RC Mech / Owner access</div>
				<h1 id="sign-in-title">Back to the<br />workbench.</h1>
				<p class="intro">Sign in to open your private garage.</p>
				<a class="button" [routerLink]="['/']" [queryParams]="{ returnTo: returnTo }">Continue to sign in</a>
			</section>
		</main>
	`,
})
export class SignIn {
	private readonly route = inject(ActivatedRoute);
	protected readonly returnTo =
		this.route.snapshot.queryParamMap.get('returnTo') ?? '/garage';
}
