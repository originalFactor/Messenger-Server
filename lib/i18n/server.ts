import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { createTranslator, LOCALE_COOKIE, resolveLocale } from ".";

export const getLocale = cache(async () => resolveLocale((await cookies()).get(LOCALE_COOKIE)?.value));
export const getTranslator = cache(async () => createTranslator(await getLocale()));
