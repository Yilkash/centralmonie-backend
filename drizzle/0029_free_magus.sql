ALTER TABLE "product_links" ALTER COLUMN "amount_kobo" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "product_links" ADD COLUMN "minimum_kobo" bigint;