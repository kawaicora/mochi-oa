declare module 'lunar-javascript' {
  export class Lunar {
    static fromDate(date: Date): Lunar
    static fromYmd(year: number, month: number, day: number): Lunar
    getYear(): number
    getMonth(): number
    getDay(): number
    getYearInChinese(): string
    getMonthInChinese(): string
    getDayInChinese(): string
    getJieQi(): string
    getFestivals(): string[]
    getOtherFestivals(): string[]
    getXingzuo(): string
    getYearShengXiao(): string
  }
  export class Solar {
    static fromDate(date: Date): Solar
    static fromYmd(year: number, month: number, day: number): Solar
    getFestivals(): string[]
    getOtherFestivals(): string[]
  }
  export class LunarYear {
    static fromYear(year: number): LunarYear
  }
}
