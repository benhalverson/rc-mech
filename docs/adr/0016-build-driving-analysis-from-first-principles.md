# Build driving analysis from first principles in Chassis Notes

**Status:** accepted

Chassis Notes will own a new Driving analysis capability rather than reuse or migrate code from the earlier `rc-racing-line-analysis` project. That project may be consulted as evidence about the problem and approaches that did not work, but its code, contracts, and accepted architecture are not the starting point; this avoids carrying an unsuccessful browser-local design into a new local-and-cloud processing model at the cost of rebuilding and validating the pipeline from first principles.
