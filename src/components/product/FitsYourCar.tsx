"use client";

import { useGarage } from "@/lib/client/garage";
import { Icon } from "@/components/ui/Icon";
import { findModelBySlug } from "@/lib/data/vehicles";
import { whatsapp } from "@/lib/data/site";

/** Fitment as the data states it: universal, a model list, or none (ask us before ordering). */
export function FitsYourCar({ fitment, title, code }: { fitment: string[]; title: string; code: string | null }) {
  const garage = useGarage();

  const universal = fitment.includes("universal");
  const models = fitment
    .filter((s) => s !== "universal")
    .map((s) => ({ slug: s, model: findModelBySlug(s) }));
  const ask = whatsapp(
    `Hi Riderzpro, will ${title}${code ? ` (${code})` : ""} fit my car?${garage ? ` I drive a ${garage.label}.` : ""}`,
  );
  const link = "text-accent underline underline-offset-2";

  return (
    <section className="border border-tint/8 bg-tint/2 p-4 md:p-5">
      <h2 className="flex items-center gap-2 font-display text-sm font-bold uppercase tracking-[0.08em]">
        <Icon name="car" size={16} className="text-accent" />
        Fits your car?
      </h2>

      {fitment.length === 0 ? (
        <p className="mt-2 text-sm text-ash">
          No fitment list for this product yet, so check your car with us before you order.{" "}
          <a href={ask} target="_blank" rel="noopener noreferrer" className={link}>
            Check your car
          </a>
        </p>
      ) : (
        <>
          {universal && <p className="mt-2 text-sm text-ash">Listed as universal, so it is not tied to one model.</p>}
          {models.length > 0 && (
            <>
              <p className="mt-2 text-sm text-ash">Listed for:</p>
              <ul className="mt-2 flex flex-wrap gap-1.5">
                {models.map(({ slug, model }) => (
                  <li key={slug} className="chip">
                    {model ? `${model.brand} ${model.name}` : slug}
                  </li>
                ))}
              </ul>
            </>
          )}
          {garage && !universal && models.length > 0 &&
            (models.some((m) => m.slug === garage.modelSlug) ? (
              <p className="mt-3 flex items-center gap-2 text-sm font-semibold text-accent">
                <Icon name="check" size={14} />
                Fits your {garage.label}
              </p>
            ) : (
              <p className="mt-3 text-sm text-ash">
                Not listed for your {garage.label}.{" "}
                <a href={ask} target="_blank" rel="noopener noreferrer" className={link}>
                  Ask us
                </a>
              </p>
            ))}
        </>
      )}
    </section>
  );
}
