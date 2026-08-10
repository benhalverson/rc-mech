# Chassis Notes public landing page

**Status:** draft

## Audience

Chassis Notes is built first for Racers who actively tune and maintain radio-controlled cars for competitive track use. Casual drivers may find it useful, but the page does not dilute its language to address generic hobby use.

## Purpose

The public site is one focused landing page. It explains the existing product and gives invited Racers a path to register or sign in. It does not add an invite-request flow, waitlist, open registration, pricing, blog, or product roadmap.

The same work replaces `RC Mech` with `Chassis Notes` across user-facing brand surfaces, including the application shell, sign-in experience, browser metadata, authentication email, passkey display name, API documentation title, and product prose. Existing repository, package, Worker, D1, R2, health-service, browser-storage, and database identifiers remain unchanged.

## Access actions

The primary action is **Enter Chassis Notes**, which opens the existing access screen for both invited Racers and returning Users. **See how it works** scrolls to the product walkthrough, while the page header provides a direct **Sign in** link. Supporting copy states that an invite is required for first registration; the page does not imply that registration is open.

The root path `/` always renders the public landing page, regardless of session state. The application remains at `/garage`; **Enter Chassis Notes** links there so the existing guard can admit signed-in Racers or send signed-out visitors to the access screen. The landing page does not fetch or infer session state.

## Metadata

- **Title:** Chassis Notes — Setup history for RC racers
- **Description:** Keep your RC car’s current setup, intentional changes, Drive sessions, trackside voice notes, and maintenance history together in one private field notebook.

## Core promise

> Know what’s on the car, what changed, and what happened next.

Setup history is the primary product story. Trackside voice notes and maintenance records support that story without presenting Chassis Notes as tuning advice or promising faster laps.

## Hero copy

> **A field notebook for RC racers**
>
> **Know what’s on the car. What changed. What happened next.**
>
> Keep the current setup, every intentional change, and what the car did next in one private history.

The hero pairs this copy with **Enter Chassis Notes**, **See how it works**, and the note **An invite is required for first registration.**

## Page narrative

The landing page follows a Racer through the work instead of presenting a feature grid:

1. **Before the first Drive session** — know the car’s current setup.
2. **Between Drive sessions** — copy the setup, record intentional changes, and preserve the previous baseline.
3. **After a Drive session** — speak what happened, review the transcript, and confirm the record.
4. **Back at the bench** — track tires, fluids, service, photos, and build details.

The canonical product term is **Drive session**, never Run.

The final page sequence is:

1. **Hero** — the core promise beside the mobile Current setup.
2. **Start with what’s on the car** — the B7 carpet baseline.
3. **Change the setup. Keep the baseline.** — the `30 wt → 35 wt` change with both Setups preserved.
4. **Say what happened while it’s fresh** — voice note, transcript, review, and confirmation.
5. **Carry the record back to the bench** — tires, fluids, service, photos, and build details.
6. **Your garage stays yours** — isolated records, explicit confirmation, and no setup advice.
7. **Final entry** — repeat the product-entry action and invite requirement.

## Product evidence

Real Chassis Notes interface screenshots are the primary visual evidence. They use believable Racer data to show the current setup, changes from previous, and voice-note review. Trackside photography may provide context, but it does not replace product UI or imply capabilities the app does not have.

The first release uses no stock, generated, scraped, or manufacturer car photography. An original B7 pit or track photo may be added later only if the Owner supplies an image they have the right to publish; until then, the visual story remains product-led.

One consistent 1/10-scale electric 2WD buggy anchors every screenshot and walkthrough section. Its records demonstrate ride height, camber, toe, shock package, gear differential, setup changes, tire service, and trackside observations without mixing unrelated example cars.

Screenshots come from a dedicated, reproducible demo garage rather than a production User’s records. The demo car is a Team Associated B7 1/10-scale electric 2WD buggy with a coherent carpet setup. Its data is realistic and stable across mobile, desktop, light, and dark captures, but it is not presented as a factory setup or tuning recommendation.

The demo follows one club-night history: a carpet baseline, an observation that the rear stepped out on corner entry, an explicit rear shock-oil change from `30 wt` to `35 wt`, the preserved baseline and new current setup, a later Drive-session observation that does not claim causation, and one tire-service entry.

The starting Setup is based on Team Associated’s published RC10B7 carpet kit setup: `13 mm` ride height, `-1°` front and rear camber, `35 wt` front shock oil, `30 wt` rear shock oil, and a `30k` gear differential. Chassis Notes labels the record **Club carpet baseline** and does not present these values as app-generated advice or a factory-endorsed Chassis Notes setup.

The hero leads with the mobile Current setup and voice-note surfaces because Chassis Notes is primarily used trackside. Wider desktop captures appear later for setup history and maintenance, making clear that the product also supports bench and desktop work without letting the desktop console dominate the first impression.

## Visual language

The landing page extends the product’s Alloy visual language with more editorial pacing. It uses Commissioner and Fragment Mono, graphite and aluminum surfaces, desaturated teal, precise rules, and restrained industrial geometry. It does not copy the authenticated application shell or introduce a separate glossy marketing skin, fake metal, gradients, glow, or generic card grids.

The page follows the visitor’s operating-system light or dark preference through the existing no-flash appearance foundation. It does not add a public appearance selector. The hero product capture matches the resolved appearance, while later evidence may deliberately show both appearances.

## Voice-note language

Chassis Notes is not positioned as an AI product. The page describes the Racer’s workflow: speak a trackside note, review its transcript and proposed records, and explicitly confirm what belongs in history. Automated transcription may appear in supporting copy, but AI is not used in the hero, navigation, or feature title, and the page never implies that Chassis Notes provides setup advice.

## Privacy and control

The page includes a visible trust section built from concrete product behavior rather than generic security claims:

- Every User has an isolated private garage.
- A voice note changes nothing until the Racer reviews and confirms it.
- Chassis Notes records decisions and observations; it does not provide setup advice.

## Evidence standard

The first release contains no testimonials, user counts, racing-team or manufacturer logos, lap-time claims, or statements such as “trusted by Racers” unless the Owner later supplies verifiable evidence and permission to publish it. The real interface and coherent B7 demo history carry the proof. Chassis Notes never implies that recording a setup makes a car faster.

## Copy voice

Copy is concise, technical, and Racer-literate without forced pit-lane slang. It uses canonical terms such as Current setup, Setup change, Drive session, tire set, and Trackside observation. It avoids startup language including “revolutionize,” “unlock performance,” “second brain,” and “AI-powered.” The page sounds like a capable Racer explaining their notebook to another capable Racer.
