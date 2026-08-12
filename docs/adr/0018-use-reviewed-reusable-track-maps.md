# Use reviewed reusable Track maps

**Status:** accepted

Each Track layout has a reviewed Track map aligned to the fixed Track view, and every Driving analysis on that layout reuses the map's corner definitions. This chooses stable, human-reviewed geometry over model-driven corner rediscovery for every race, adding a one-time mapping step while keeping Corner pass timing comparable and preventing a changed model from silently redefining the evidence.
