"use client";

import { motion } from "framer-motion";
import { SparkMark } from "@/app/components/Wordmark";
import { WHY, WHY_PREVIEW } from "@/app/components/site/site-content";
import { headerReveal, riseReveal, scaleReveal } from "@/app/components/site/site-motion";
import { Bubbles } from "@/app/components/site/Bubbles";

const COPY_CARD = "flex flex-col gap-6 rounded-card bg-day-card p-8 md:p-9 lg:col-span-2";

/**
 * A coded mock of one tutor reply, standing where the reference shows its
 * founder video. Illustrative content, labelled as a sample on its face.
 */
function FeedbackPreview() {
  return (
    <div className="flex h-full min-h-96 flex-col gap-4 rounded-card bg-day-panel p-6 font-urbanist text-white md:p-8">
      <div className="flex items-center justify-between gap-3">
        <span className="inline-flex items-center gap-2 text-lg">
          <SparkMark className="size-5" />
          AIA Tutor
        </span>
        <span className="rounded-full bg-white/10 px-3 py-1 text-sm text-white/80">{WHY_PREVIEW.label}</span>
      </div>

      <div className="ml-auto max-w-xs rounded-2xl rounded-br-md bg-day-blue px-4 py-3 text-base">
        Uploaded DayBook.xml and TrialBalance.xml
      </div>

      <div className="mr-auto flex max-w-sm flex-col gap-3 rounded-2xl rounded-bl-md bg-white/8 px-5 py-4 text-base leading-relaxed">
        <span className="text-sm text-white/55">{WHY_PREVIEW.batch}</span>
        <span className="text-lg font-semibold">{WHY_PREVIEW.result}</span>
        <span className="flex gap-2.5">
          <span aria-hidden="true" className="mt-2 size-2 shrink-0 rounded-full bg-status-success" />
          {WHY_PREVIEW.praise}
        </span>
        <span className="flex gap-2.5">
          <span aria-hidden="true" className="mt-2 size-2 shrink-0 rounded-full bg-status-warning" />
          {WHY_PREVIEW.flag}
        </span>
        <span className="w-fit rounded-full bg-status-success/20 px-3 py-1 text-sm text-white">{WHY_PREVIEW.fixed}</span>
        <span className="text-white/70">{WHY_PREVIEW.next}</span>
      </div>
    </div>
  );
}

/**
 * "Why AIA Academy?": two copy cards either side of the feedback preview,
 * then the four mechanics that stand in for the reference's adoption stats.
 * Cells grow in from 0.85 and their copy rises after them, 0.2s apart, as on
 * the reference.
 */
export function WhySection() {
  return (
    <section id="why" aria-labelledby="why-title" className="relative overflow-hidden py-28 md:py-36">
      <Bubbles />

      <div className="relative mx-auto max-w-7xl px-5 md:px-8">
        <motion.h2 id="why-title" {...headerReveal()} className="day-heading text-center font-nunito">
          {WHY.title}
        </motion.h2>

        <div className="mt-14 grid gap-5 md:mt-20 lg:grid-cols-7">
          <motion.div {...scaleReveal(0.3)} className={COPY_CARD}>
            {WHY.left.map((line, index) => (
              <motion.p key={line} {...riseReveal(0.5 + index * 0.2)} className="font-nunito text-lg leading-relaxed md:text-xl">
                {line}
              </motion.p>
            ))}
          </motion.div>

          <motion.figure {...scaleReveal(0.4)} className="flex flex-col lg:col-span-3">
            <FeedbackPreview />
            <figcaption className="mt-6 text-center font-nunito">
              <span className="block text-2xl">{WHY.caption.name}</span>
              <span className="mt-1 block text-xl text-day-muted">{WHY.caption.role}</span>
            </figcaption>
          </motion.figure>

          <motion.div {...scaleReveal(0.5)} className={COPY_CARD}>
            {WHY.right.map((line, index) => (
              <motion.p key={line} {...riseReveal(0.7 + index * 0.2)} className="font-nunito text-lg leading-relaxed md:text-xl">
                {line}
              </motion.p>
            ))}
          </motion.div>
        </div>

        <dl className="mt-20 grid gap-12 text-center sm:grid-cols-2 md:mt-28 lg:grid-cols-4 lg:gap-8">
          {WHY.stats.map((stat, index) => (
            <motion.div
              key={stat.text}
              {...riseReveal(0.3 + index * 0.2)}
              className="flex flex-col-reverse justify-end gap-4"
            >
              <dd className="mx-auto max-w-xs font-nunito text-lg leading-relaxed md:text-xl">{stat.text}</dd>
              <dt className="font-nunito">
                <span className="day-stat">{stat.figure}</span>
                {stat.unit && <span className="ml-2 text-3xl">{stat.unit}</span>}
              </dt>
            </motion.div>
          ))}
        </dl>
      </div>
    </section>
  );
}
