# Use D1 with Drizzle and private R2 media

**Status:** accepted

Relational garage data is stored in D1 and accessed through Drizzle ORM. Car photos are stored in a private R2 bucket and streamed only after ownership checks, while Cloudflare Email Service delivers magic links. This keeps structured data queryable at the edge and media out of the database, at the cost of managing migrations, object metadata, and email delivery as separate concerns.
