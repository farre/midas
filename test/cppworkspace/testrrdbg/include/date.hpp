#pragma once
#include <iostream>
struct Date {
	int day, month, year;
	friend std::ostream& operator<<(std::ostream& os, const Date& date) {
		if(date.day < 10) {	
			os << date.year << "-" << date.month << "-" << '0' << date.day;
		} else {
			os << date.year << "-" << date.month << "-" << date.day;
		}
		return os;
	}
};
